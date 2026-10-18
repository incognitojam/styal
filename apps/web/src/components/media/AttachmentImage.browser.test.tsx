import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { AttachmentImage } from "./AttachmentImage";
import { prepareImageForAttachment } from "../../lib/imageCompression";

vi.mock("../../lib/imageCompression", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/imageCompression")>()),
  prepareImageForAttachment: vi.fn(),
}));

let root: Root;
let container: HTMLDivElement;
const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const converted = `${png}#converted`;
const image = () => container.querySelector("img")!;
const renderImage = async (props: ComponentProps<typeof AttachmentImage>) => {
  await act(() => root.render(<AttachmentImage {...props} />));
};
const failNativeDecode = async () => {
  await act(() => image().dispatchEvent(new Event("error")));
};
const fetchImage = vi.fn();
const revokeUrl = vi.fn();
const jpeg = new File(["jpeg"], "photo.jpg", { type: "image/jpeg" });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.stubGlobal("fetch", fetchImage);
  vi.spyOn(URL, "createObjectURL").mockReturnValue(converted);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(revokeUrl);
  fetchImage.mockResolvedValue(new Response(new Blob(["heic"])));
  vi.mocked(prepareImageForAttachment).mockResolvedValue({
    ok: true,
    file: jpeg,
    recompressed: true,
  });
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it.each([
  { name: "photo.HEIC", mimeType: undefined },
  { name: "photo", mimeType: "image/heif" },
])(
  "converts $name after native decoding fails and releases its preview",
  async ({ name, mimeType }) => {
    await renderImage({ src: png, name, mimeType });
    expect(fetchImage).not.toHaveBeenCalled();
    await failNativeDecode();
    await vi.waitFor(() => expect(image().src).toBe(converted));
    expect(prepareImageForAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ name, type: "image/heic" }),
      50 * 1024 * 1024,
    );
    await act(() => root.unmount());
    expect(revokeUrl).toHaveBeenCalledWith(converted);
  },
);

it("leaves PNG errors to the caller without fetching or converting", async () => {
  const onError = vi.fn();
  await renderImage({ src: png, name: "photo.png", onError });
  await failNativeDecode();
  await vi.waitFor(() =>
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ type: "error" })),
  );
  expect(fetchImage).not.toHaveBeenCalled();
});

it("reports failed HEIC conversion through the existing error handler", async () => {
  const onError = vi.fn();
  vi.mocked(prepareImageForAttachment).mockResolvedValue({ ok: false, reason: "unreadable" });
  await renderImage({ src: png, name: "photo.heif", onError });
  await failNativeDecode();
  await vi.waitFor(() =>
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ type: "error" })),
  );
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it("discards an old decode when navigating to a different source", async () => {
  let finishDecode!: (result: Awaited<ReturnType<typeof prepareImageForAttachment>>) => void;
  vi.mocked(prepareImageForAttachment).mockReturnValue(
    new Promise((resolve) => {
      finishDecode = resolve;
    }),
  );
  await renderImage({ src: `${png}#first`, name: "photo.heic" });
  await failNativeDecode();
  await vi.waitFor(() => expect(prepareImageForAttachment).toHaveBeenCalled());
  await renderImage({ src: `${png}#second`, name: "photo.heic" });
  await act(() => finishDecode({ ok: true, file: jpeg, recompressed: true }));
  expect(image().src).toBe(`${png}#second`);
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(fetchImage.mock.calls[0]?.[1].signal.aborted).toBe(true);
});
