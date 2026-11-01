import type { ChatAttachment, OrchestrationMessageContext } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  imageGridTileSize,
  messageImageLayout,
  userMessageAttachmentLayout,
} from "./messageImageGrid";

const image = (id: string) =>
  ({
    type: "image",
    id,
    name: `${id}.png`,
    mimeType: "image/png",
    sizeBytes: 10,
  }) as ChatAttachment;
const file = (id: string, mimeType = "application/pdf") =>
  ({ type: "file", id, name: `${id}.bin`, mimeType, sizeBytes: 10 }) as ChatAttachment;

const binding = (contextId: string, kind: "image" | "file", attachmentId: string) => ({
  version: 1,
  contextId,
  label: attachmentId,
  kind,
  attachmentId,
  name: attachmentId,
  mimeType: kind === "image" ? "image/png" : "application/pdf",
  sizeBytes: 10,
});
const context = (...records: ReturnType<typeof binding>[]) =>
  ({ version: 1, records }) as unknown as OrchestrationMessageContext;

const ids = (attachments: readonly ChatAttachment[]) => attachments.map((a) => a.id);

describe("messageImageLayout", () => {
  it("keeps a single image in the large layout", () => {
    expect(messageImageLayout([])).toEqual({ kind: "none" });
    expect(messageImageLayout(["a"])).toEqual({ kind: "single", image: "a" });
  });

  it("shows two to four images as tiles with nothing hidden", () => {
    expect(messageImageLayout(["a", "b"])).toEqual({
      kind: "grid",
      tiles: ["a", "b"],
      hiddenCount: 0,
    });
    expect(messageImageLayout(["a", "b", "c", "d"])).toEqual({
      kind: "grid",
      tiles: ["a", "b", "c", "d"],
      hiddenCount: 0,
    });
  });

  it("shows the first four images and counts the rest", () => {
    expect(messageImageLayout(["a", "b", "c", "d", "e"])).toEqual({
      kind: "grid",
      tiles: ["a", "b", "c", "d"],
      hiddenCount: 1,
    });
    const many = Array.from({ length: 34 }, (_, index) => `img${index}`);
    expect(messageImageLayout(many)).toMatchObject({
      tiles: ["img0", "img1", "img2", "img3"],
      hiddenCount: 30,
    });
  });
});

describe("imageGridTileSize", () => {
  it("splits the width into two columns around the gap", () => {
    expect(imageGridTileSize(300)).toBe(146);
    expect(imageGridTileSize(301)).toBe(146);
  });

  it("caps tiles on wide layouts and never goes negative", () => {
    expect(imageGridTileSize(1200)).toBe(240);
    expect(imageGridTileSize(4)).toBe(0);
  });
});

describe("userMessageAttachmentLayout", () => {
  it("puts images in the grid and other files in the list, in order", () => {
    const layout = userMessageAttachmentLayout({
      text: "here",
      attachments: [image("a"), file("f1"), image("b"), file("f2")],
    });
    expect(ids(layout.gridImages)).toEqual(["a", "b"]);
    expect(ids(layout.listedAttachments)).toEqual(["f1", "f2"]);
  });

  it("treats a file with an image mime type as an image", () => {
    const layout = userMessageAttachmentLayout({
      text: "",
      attachments: [file("shot", "image/jpeg"), file("doc")],
    });
    expect(ids(layout.gridImages)).toEqual(["shot"]);
    expect(ids(layout.listedAttachments)).toEqual(["doc"]);
  });

  it("keeps images the text references in the grid", () => {
    const layout = userMessageAttachmentLayout({
      text: "Compare ![a.png](t3-context://v1/image/ctx_a) and ![b.png](t3-context://v1/image/ctx_b)",
      context: context(binding("ctx_a", "image", "a"), binding("ctx_b", "image", "b")),
      attachments: [image("a"), image("b"), image("c")],
    });
    expect(ids(layout.gridImages)).toEqual(["a", "b", "c"]);
    expect(layout.listedAttachments).toEqual([]);
  });

  it("leaves files the text references out of the list, since they show as chips", () => {
    const layout = userMessageAttachmentLayout({
      text: "Read [spec.pdf](t3-context://v1/file/ctx_spec)",
      context: context(binding("ctx_spec", "file", "spec"), binding("ctx_other", "file", "other")),
      attachments: [file("spec"), file("other")],
    });
    // `other` has a context record but the text never references it, so it stays listed.
    expect(ids(layout.listedAttachments)).toEqual(["other"]);
  });
});
