import { describe, expect, it, vi } from "vite-plus/test";

import { toOpenCodeFileParts } from "./opencodeRuntime.ts";

describe("toOpenCodeFileParts", () => {
  it("sends images natively but leaves generic files for the path prompt", () => {
    const resolveAttachmentPath = vi.fn(() => "/tmp/screenshot.png");

    const parts = toOpenCodeFileParts({
      attachments: [
        {
          type: "file",
          id: "file-1",
          name: "notes.md",
          mimeType: "text/markdown",
          sizeBytes: 7,
        },
        {
          type: "image",
          id: "image-1",
          name: "screenshot.png",
          mimeType: "image/png",
          sizeBytes: 8,
        },
      ],
      resolveAttachmentPath,
    });

    expect(resolveAttachmentPath).toHaveBeenCalledTimes(1);
    expect(parts).toEqual([
      {
        type: "file",
        mime: "image/png",
        filename: "screenshot.png",
        url: "file:///tmp/screenshot.png",
      },
    ]);
  });
});
