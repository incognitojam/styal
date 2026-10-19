import { EnvironmentId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn<() => Promise<string | null>>() }));

vi.mock(import("~/assets/assetUrls"), async (original) => ({
  ...(await original()),
  useAssetUrlRefresh: () => refresh,
}));
// The real source view highlights through a worker pool; the text it receives is what matters here.
// Never load the original: its highlighter graph can outlast waitFor on a cold CI browser.
vi.mock(import("./ReadOnlySourcePreview"), () => ({
  default: ({ text }: { text: string }) => <pre>{text}</pre>,
}));

vi.mock(import("../../lib/imageCompression"), async (original) => ({
  ...(await original()),
  prepareImageForAttachment: vi.fn(),
}));

import { prepareImageForAttachment } from "../../lib/imageCompression";
import { AttachmentFilePreview } from "./AttachmentFilePreview";

describe("attachment HTML preview recovery", () => {
  const originalUrl = "data:text/html,original";
  const renewedUrl = "data:text/html,renewed";
  let now = 0;
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    refresh.mockReset().mockResolvedValueOnce(originalUrl).mockResolvedValue(renewedUrl);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<p>Captured HTML</p>")),
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const openRemote = () =>
    act(async () =>
      root.render(
        <AttachmentFilePreview
          name="document.html"
          mimeType="text/html"
          sizeBytes={100}
          asset={{ environmentId: EnvironmentId.make("test-environment"), attachmentId: "html" }}
        />,
      ),
    );

  const toggleMode = async (label: string) => {
    const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    expect(button, label).not.toBeNull();
    await act(async () => button!.click());
  };
  const alert = () => container.querySelector('[role="alert"]');

  it("keeps a renewed URL for subsequent rendered and source views", async () => {
    await openRemote();
    expect(container.querySelector("iframe")?.getAttribute("src")).toBe(originalUrl);
    now = 61 * 60_000;
    await toggleMode("Show HTML source");
    await act(async () => {
      await import("./ReadOnlySourcePreview");
    });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(renewedUrl, expect.any(Object));
    await vi.waitFor(() =>
      expect(container.querySelector("pre")?.textContent).toBe("<p>Captured HTML</p>"),
    );

    await toggleMode("Show rendered page");
    expect(container.querySelector("iframe")?.getAttribute("src")).toBe(renewedUrl);
    await toggleMode("Show HTML source");
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([renewedUrl, renewedUrl]);
  });

  it("does not fetch or mark an expired URL fresh when reauthorization is unavailable", async () => {
    await openRemote();
    now = 61 * 60_000;
    refresh.mockResolvedValue(null);
    await toggleMode("Show HTML source");
    expect(fetch).not.toHaveBeenCalled();
    expect(alert()?.textContent).toContain("Reconnect to the environment and try again.");

    await toggleMode("Show rendered page");
    await toggleMode("Show HTML source");
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("can return to rendered HTML after local source decoding fails", async () => {
    const file = new Blob([new Uint8Array([0x3c, 0x70, 0x3e, 0xe9])], { type: "text/html" });
    await act(async () =>
      root.render(
        <AttachmentFilePreview
          name="document.html"
          mimeType="text/html"
          sizeBytes={file.size}
          file={file}
        />,
      ),
    );
    await toggleMode("Show HTML source");
    await vi.waitFor(() => expect(alert()?.textContent).toContain("not UTF-8"));

    await toggleMode("Show rendered page");
    expect(alert()).toBeNull();
    expect(container.querySelector("iframe")?.title).toBe("document.html");
  });
});

describe("attachment image preview fallback", () => {
  let root: Root;
  let container: HTMLDivElement;
  const sourceUrl = "data:application/octet-stream,heic";
  const jpeg = new File(["jpeg"], "photo.jpg", { type: "image/jpeg" });

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    refresh.mockReset().mockResolvedValue(sourceUrl);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Blob(["heic"]))),
    );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:jpeg");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.mocked(prepareImageForAttachment).mockReset().mockResolvedValue({
      ok: true,
      file: jpeg,
      recompressed: true,
    });
    container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const openImage = (name: string, mimeType: string) =>
    act(() =>
      root.render(
        <AttachmentFilePreview
          name={name}
          mimeType={mimeType}
          sizeBytes={100}
          asset={{ environmentId: EnvironmentId.make("test-environment"), attachmentId: "photo" }}
        />,
      ),
    );

  const failDecode = () =>
    act(() => {
      const image = container.querySelector("img");
      expect(image).not.toBeNull();
      image!.dispatchEvent(new Event("error"));
    });

  it.each([
    { name: "photo.HEIC", mimeType: "image/heic" },
    { name: "photo", mimeType: "image/heif" },
  ])("converts stored $name after native decoding fails", async ({ name, mimeType }) => {
    await openImage(name, mimeType);
    await failDecode();

    expect(fetch).toHaveBeenCalledWith(
      sourceUrl,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(prepareImageForAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ name, type: "image/heic" }),
      50 * 1024 * 1024,
    );
    expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:jpeg");
    expect(container.textContent).not.toContain("Unable to load image.");
  });

  it("shows the existing failure when HEIC conversion fails", async () => {
    vi.mocked(prepareImageForAttachment).mockResolvedValue({ ok: false, reason: "unreadable" });
    await openImage("photo.heic", "image/heic");
    await failDecode();
    expect(container.textContent).toContain("Unable to load image.");
  });

  it("shows PNG decoding failures without attempting HEIC conversion", async () => {
    await openImage("photo.png", "image/png");
    await failDecode();
    expect(container.textContent).toContain("Unable to load image.");
    expect(prepareImageForAttachment).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
