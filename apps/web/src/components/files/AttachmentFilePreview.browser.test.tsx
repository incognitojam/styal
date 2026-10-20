import { act, render, stubGlobal, type Screen } from "../../../test/render";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

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

  function setup() {
    refresh.mockReset().mockResolvedValueOnce(originalUrl).mockResolvedValue(renewedUrl);
  }

  const openRemote = () =>
    render(
      <AttachmentFilePreview
        name="document.html"
        mimeType="text/html"
        sizeBytes={100}
        asset={{ environmentId: EnvironmentId.make("test-environment"), attachmentId: "html" }}
      />,
    );

  const toggleMode = async (screen: Screen, label: string) => {
    const button = screen.container.querySelector<HTMLButtonElement>(
      `button[aria-label="${label}"]`,
    );
    expect(button, label).not.toBeNull();
    await act(async () => button!.click());
  };
  const alert = (screen: Screen) => screen.container.querySelector('[role="alert"]');

  it("keeps a renewed URL for subsequent rendered and source views", async () => {
    setup();
    let now = 0;
    using _now = vi.spyOn(Date, "now").mockImplementation(() => now);
    using _fetch = stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<p>Captured HTML</p>")),
    );
    await using screen = await openRemote();
    expect(screen.container.querySelector("iframe")?.getAttribute("src")).toBe(originalUrl);
    now = 61 * 60_000;
    await toggleMode(screen, "Show HTML source");
    await act(async () => {
      await import("./ReadOnlySourcePreview");
    });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(renewedUrl, expect.any(Object));
    await vi.waitFor(() =>
      expect(screen.container.querySelector("pre")?.textContent).toBe("<p>Captured HTML</p>"),
    );

    await toggleMode(screen, "Show rendered page");
    expect(screen.container.querySelector("iframe")?.getAttribute("src")).toBe(renewedUrl);
    await toggleMode(screen, "Show HTML source");
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([renewedUrl, renewedUrl]);
  });

  it("does not fetch or mark an expired URL fresh when reauthorization is unavailable", async () => {
    setup();
    let now = 0;
    using _now = vi.spyOn(Date, "now").mockImplementation(() => now);
    using _fetch = stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<p>Captured HTML</p>")),
    );
    await using screen = await openRemote();
    now = 61 * 60_000;
    refresh.mockResolvedValue(null);
    await toggleMode(screen, "Show HTML source");
    expect(fetch).not.toHaveBeenCalled();
    expect(alert(screen)?.textContent).toContain("Reconnect to the environment and try again.");

    await toggleMode(screen, "Show rendered page");
    await toggleMode(screen, "Show HTML source");
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("can return to rendered HTML after local source decoding fails", async () => {
    setup();
    let now = 0;
    using _now = vi.spyOn(Date, "now").mockImplementation(() => now);
    using _fetch = stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<p>Captured HTML</p>")),
    );
    const file = new Blob([new Uint8Array([0x3c, 0x70, 0x3e, 0xe9])], { type: "text/html" });
    await using screen = await render(
      <AttachmentFilePreview
        name="document.html"
        mimeType="text/html"
        sizeBytes={file.size}
        file={file}
      />,
    );
    await toggleMode(screen, "Show HTML source");
    await vi.waitFor(() => expect(alert(screen)?.textContent).toContain("not UTF-8"));

    await toggleMode(screen, "Show rendered page");
    expect(alert(screen)).toBeNull();
    expect(screen.container.querySelector("iframe")?.title).toBe("document.html");
  });
});

describe("attachment image preview fallback", () => {
  const sourceUrl = "data:application/octet-stream,heic";
  const jpeg = new File(["jpeg"], "photo.jpg", { type: "image/jpeg" });
  // A decodable image, so the converted preview is not itself reported as a decode failure.
  const convertedUrl =
    "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

  function setup() {
    using stack = new DisposableStack();
    refresh.mockReset().mockResolvedValue(sourceUrl);
    stack.use(
      stubGlobal(
        "fetch",
        vi.fn(async () => new Response(new Blob(["heic"]))),
      ),
    );
    stack.use(vi.spyOn(URL, "createObjectURL").mockReturnValue(convertedUrl));
    stack.use(vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {}));
    vi.mocked(prepareImageForAttachment).mockReset().mockResolvedValue({
      ok: true,
      file: jpeg,
      recompressed: true,
    });
    return stack.move();
  }

  const openImage = (name: string, mimeType: string) =>
    render(
      <AttachmentFilePreview
        name={name}
        mimeType={mimeType}
        sizeBytes={100}
        asset={{ environmentId: EnvironmentId.make("test-environment"), attachmentId: "photo" }}
      />,
    );

  const failure = (screen: Screen) =>
    vi.waitFor(() => expect(screen.container.textContent).toContain("Unable to load image."));

  it.each([
    { name: "photo.HEIC", mimeType: "image/heic" },
    { name: "photo", mimeType: "image/heif" },
  ])("converts stored $name after native decoding fails", async ({ name, mimeType }) => {
    using _setup = setup();
    // The stored source is not an image the browser can decode, so its own error starts the fallback.
    await using screen = await openImage(name, mimeType);
    await vi.waitFor(() =>
      expect(screen.container.querySelector("img")?.getAttribute("src")).toBe(convertedUrl),
    );
    expect(fetch).toHaveBeenCalledWith(
      sourceUrl,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(prepareImageForAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ name, type: "image/heic" }),
      50 * 1024 * 1024,
    );
    expect(screen.container.textContent).not.toContain("Unable to load image.");
  });

  it("shows the existing failure when HEIC conversion fails", async () => {
    using _setup = setup();
    vi.mocked(prepareImageForAttachment).mockResolvedValue({ ok: false, reason: "unreadable" });
    await using screen = await openImage("photo.heic", "image/heic");
    await failure(screen);
    expect(prepareImageForAttachment).toHaveBeenCalledOnce();
  });

  it("shows PNG decoding failures without attempting HEIC conversion", async () => {
    using _setup = setup();
    await using screen = await openImage("photo.png", "image/png");
    await failure(screen);
    expect(prepareImageForAttachment).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
