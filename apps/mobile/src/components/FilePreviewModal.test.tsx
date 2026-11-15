import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, SOURCE_CONTROL_MEDIA_ASSET } from "@t3tools/contracts";

const harness = vi.hoisted(() => ({
  refreshAssetUrl: vi.fn<(environmentId: string, resource: { url: string }) => Promise<string>>(),
  alert: vi.fn(),
  previews: [] as unknown[],
  mounts: 0,
  presentationFinished: false,
  platform: { OS: process.env.T3_MOBILE_TEST_PLATFORM === "android" ? "android" : "ios" },
}));

vi.mock("react-native", () => ({ Platform: harness.platform }));
vi.mock("../state/assets", () => ({ refreshAssetUrl: harness.refreshAssetUrl }));
vi.mock("../lib/localAttachmentPreview", () => ({ loadLocalAttachmentPreview: vi.fn() }));
vi.mock("../lib/attachmentDownload", () => ({
  downloadAndShareAttachment: vi.fn(),
  nativeViewerErrorMessage: () => "",
  shareLocalAttachment: vi.fn(),
}));
vi.mock("../lib/previewPresentation", () => ({ usePreviewPresentation: () => {} }));
vi.mock("./ui/Dialog", () => ({ alert: harness.alert }));
vi.mock("./FilePreview", async () => {
  const { useEffect, useState } = await import("react");
  return {
    FilePreview: (props: { source: unknown; onPresent?: (isFinished: () => boolean) => void }) => {
      useState(() => harness.mounts++);
      harness.previews.push(props.source);
      const { onPresent } = props;
      // Stands in for the native presentation starting.
      useEffect(() => onPresent?.(() => harness.presentationFinished), [onPresent]);
      return null;
    },
  };
});

import type { FilePreviewItem } from "./FilePreviewModal.types";
import { FilePreviewModal } from "./FilePreviewModal";

const environmentId = EnvironmentId.make("environment");
const image = (url: string): FilePreviewItem => ({
  kind: "image",
  environmentId,
  resource: { _tag: SOURCE_CONTROL_MEDIA_ASSET, cwd: "/repo", url },
});

async function openGallery(
  selected: FilePreviewItem,
  gallery: readonly FilePreviewItem[],
  platform = harness.platform.OS,
) {
  harness.platform.OS = platform;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.previews.length = 0;
  harness.mounts = 0;
  harness.alert.mockClear();
  const root = createRoot(document.createElement("div"));
  const onRequestClose = vi.fn();
  await act(async () =>
    root.render(
      <FilePreviewModal source={{ ...selected, gallery }} onRequestClose={onRequestClose} />,
    ),
  );
  return { onRequestClose, [Symbol.asyncDispose]: () => act(async () => root.unmount()) };
}

it("keeps the gallery stable while a sibling is still resolving", async () => {
  const platform = harness.platform.OS;
  const slow = Promise.withResolvers<string>();
  harness.refreshAssetUrl.mockImplementation(async (_environmentId, resource) =>
    resource.url.endsWith("slow.png") ? slow.promise : "https://signed.test/a.png",
  );
  const selected = image("https://github.com/a.png");
  await using _preview = await openGallery(
    selected,
    [image("https://github.com/slow.png"), selected],
    platform,
  );

  if (platform === "ios") {
    expect(harness.previews.at(-1)).toMatchObject({
      kind: "image",
      selectedIndex: 1,
      images: [
        expect.not.objectContaining({ uri: expect.anything() }),
        { uri: "https://signed.test/a.png" },
      ],
    });
  } else {
    expect(harness.previews).toEqual([]);
  }
  await act(async () => slow.resolve("https://signed.test/slow.png"));
  expect(harness.previews.at(-1)).toMatchObject({
    selectedIndex: 1,
    images: [{ uri: "https://signed.test/slow.png" }, { uri: "https://signed.test/a.png" }],
  });
  expect(harness.mounts).toBe(1);
});

it("handles a failed sibling without leaving a pending page", async () => {
  const platform = harness.platform.OS;
  harness.refreshAssetUrl.mockImplementation(async (_environmentId, resource) => {
    if (resource.url.endsWith("missing.png")) throw new Error("not found");
    return `https://signed.test/${resource.url.split("/").pop()}`;
  });
  const selected = image("https://github.com/a.png");
  await using preview = await openGallery(
    selected,
    [selected, image("https://github.com/missing.png"), image("https://github.com/c.png")],
    platform,
  );

  if (platform === "android") {
    expect(preview.onRequestClose).toHaveBeenCalledOnce();
    expect(harness.alert).toHaveBeenCalledOnce();
    expect(harness.previews).toEqual([]);
    return;
  }

  expect(preview.onRequestClose).not.toHaveBeenCalled();
  expect(harness.alert).not.toHaveBeenCalled();
  expect(harness.previews.at(-1)).toMatchObject({
    selectedIndex: 0,
    images: [
      { uri: "https://signed.test/a.png" },
      { failed: true },
      { uri: "https://signed.test/c.png" },
    ],
  });
});

it("closes the preview when the selected image cannot be resolved", async () => {
  harness.refreshAssetUrl.mockImplementation(async (_environmentId, resource) => {
    if (resource.url.endsWith("missing.png")) throw new Error("not found");
    return `https://signed.test/${resource.url.split("/").pop()}`;
  });
  const selected = image("https://github.com/missing.png");
  await using preview = await openGallery(selected, [image("https://github.com/a.png"), selected]);

  expect(preview.onRequestClose).toHaveBeenCalledOnce();
  expect(harness.alert).toHaveBeenCalledOnce();
});

it.each([
  // Handed to native but not yet started there, or still on screen.
  ["image", false, 1],
  ["image", true, 2],
  // A PDF is still resolving here, so its viewer never presented and a re-render must not restart it.
  ["pdf", true, 1],
] as const)(
  "a re-tap of the open %s restarts the preview only once its native viewer closed (closed: %s)",
  async (kind, finished, starts) => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    harness.presentationFinished = finished;
    harness.mounts = 0;
    harness.refreshAssetUrl.mockReset();
    if (kind === "image") harness.refreshAssetUrl.mockResolvedValue("https://signed.test/a.png");
    else harness.refreshAssetUrl.mockReturnValue(new Promise(() => {}));
    const selected: FilePreviewItem = { ...image("https://github.com/a.png"), kind };
    const root = createRoot(document.createElement("div"));
    await using _root = { [Symbol.asyncDispose]: () => act(async () => root.unmount()) };
    const render = () =>
      act(async () =>
        root.render(
          <FilePreviewModal
            source={{ ...selected, gallery: [selected] }}
            onRequestClose={() => {}}
          />,
        ),
      );
    await render();
    await render();
    expect(harness.refreshAssetUrl).toHaveBeenCalledTimes(starts);
  },
);

it("does not carry a presented viewer over to a different item that is still resolving", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.presentationFinished = true;
  harness.refreshAssetUrl.mockReset();
  harness.refreshAssetUrl.mockImplementation((_environmentId, resource) =>
    resource.url.endsWith("a.png")
      ? Promise.resolve("https://signed.test/a.png")
      : new Promise(() => {}),
  );
  const shown = image("https://github.com/a.png");
  const resolving: FilePreviewItem = { ...image("https://github.com/b.pdf"), kind: "pdf" };
  const root = createRoot(document.createElement("div"));
  await using _root = { [Symbol.asyncDispose]: () => act(async () => root.unmount()) };
  const render = (item: FilePreviewItem) =>
    act(async () =>
      root.render(
        <FilePreviewModal source={{ ...item, gallery: [item] }} onRequestClose={() => {}} />,
      ),
    );
  await render(shown);
  await render(resolving);
  await render(resolving);
  expect(
    harness.refreshAssetUrl.mock.calls.filter(([, r]) => r.url.endsWith("b.pdf")),
  ).toHaveLength(1);
});
