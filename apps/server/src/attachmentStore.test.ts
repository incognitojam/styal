// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  attachmentRelativePath,
  createAttachmentId,
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPath,
  resolveAttachmentPathById,
  toSafeAttachmentBasename,
} from "./attachmentStore.ts";

describe("attachmentStore", () => {
  it("sanitizes thread ids when creating attachment ids", () => {
    const attachmentId = createAttachmentId("thread.folder/unsafe space");
    expect(attachmentId).toBeTruthy();
    if (!attachmentId) {
      return;
    }

    const threadSegment = parseThreadSegmentFromAttachmentId(attachmentId);
    expect(threadSegment).toBeTruthy();
    expect(threadSegment).toMatch(/^[a-z0-9_-]+$/i);
    expect(threadSegment).not.toContain(".");
    expect(threadSegment).not.toContain("%");
    expect(threadSegment).not.toContain("/");
  });

  it("parses exact thread segments from attachment ids without prefix collisions", () => {
    const fooId = "foo-00000000-0000-4000-8000-000000000001";
    const fooBarId = "foo-bar-00000000-0000-4000-8000-000000000002";

    expect(parseThreadSegmentFromAttachmentId(fooId)).toBe("foo");
    expect(parseThreadSegmentFromAttachmentId(fooBarId)).toBe("foo-bar");
  });

  it("normalizes created thread segments to lowercase", () => {
    const attachmentId = createAttachmentId("Thread.Foo");
    expect(attachmentId).toBeTruthy();
    if (!attachmentId) {
      return;
    }
    expect(parseThreadSegmentFromAttachmentId(attachmentId)).toBe("thread-foo");
  });

  it("preserves a safe image basename below its attachment id", () => {
    expect(
      attachmentRelativePath({
        type: "image",
        id: "thread-1-attachment",
        name: "screenshots/checkout failure.png",
        mimeType: "image/png",
        sizeBytes: 5,
      }),
    ).toBe("thread-1-attachment/checkout failure.png");
  });

  it("forces the inferred image extension instead of trusting the uploaded name", () => {
    expect(
      attachmentRelativePath({
        type: "image",
        id: "thread-1-attachment",
        name: "payload.html",
        mimeType: "image/png",
        sizeBytes: 5,
      }),
    ).toBe("thread-1-attachment/payload.png");
  });

  it("sanitizes cross-platform basenames and preserves extensions when truncating", () => {
    expect(
      toSafeAttachmentBasename({
        name: String.raw`C:\temp\report:final?.png`,
        extension: ".png",
      }),
    ).toBe("report_final_.png");
    expect(
      toSafeAttachmentBasename({
        name: `${"🖼️".repeat(100)}.png`,
        extension: ".png",
      }),
    ).toMatch(/\.png$/);
    expect(
      Buffer.byteLength(
        toSafeAttachmentBasename({
          name: `${"🖼️".repeat(100)}.png`,
          extension: ".png",
        }),
      ),
    ).toBeLessThanOrEqual(180);
  });

  it.each(["COM¹.png", "COM².png", "COM³.png", "LPT¹.png", "LPT².png", "LPT³.png"])(
    "prefixes the Windows reserved device name %s",
    (name) => {
      expect(toSafeAttachmentBasename({ name, extension: ".png" })).toBe(`_${name}`);
    },
  );

  it("resolves the named layout from attachment metadata and id", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-store-"),
    );
    try {
      const attachment = {
        type: "image" as const,
        id: "thread-1-attachment",
        name: "checkout failure.png",
        mimeType: "image/png",
        sizeBytes: 5,
      };
      const namedPath = NodePath.join(attachmentsDir, attachment.id, attachment.name);
      NodeFS.mkdirSync(NodePath.dirname(namedPath), { recursive: true });
      NodeFS.writeFileSync(namedPath, Buffer.from("hello"));

      expect(resolveAttachmentPath({ attachmentsDir, attachment })).toBe(namedPath);
      expect(resolveAttachmentPathById({ attachmentsDir, attachmentId: attachment.id })).toBe(
        namedPath,
      );
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("selects the named path for a new attachment and falls back for legacy images", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-store-"),
    );
    try {
      const attachment = {
        type: "image" as const,
        id: "thread-1-attachment",
        name: "checkout failure.png",
        mimeType: "image/png",
        sizeBytes: 5,
      };
      const namedPath = NodePath.join(attachmentsDir, attachment.id, attachment.name);
      expect(resolveAttachmentPath({ attachmentsDir, attachment })).toBe(namedPath);

      const legacyPath = NodePath.join(attachmentsDir, `${attachment.id}.png`);
      NodeFS.writeFileSync(legacyPath, Buffer.from("hello"));
      expect(resolveAttachmentPath({ attachmentsDir, attachment })).toBe(legacyPath);
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("resolves attachment path by id using the extension that exists on disk", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-store-"),
    );
    try {
      const attachmentId = "thread-1-attachment";
      const pngPath = NodePath.join(attachmentsDir, `${attachmentId}.png`);
      NodeFS.writeFileSync(pngPath, Buffer.from("hello"));

      const resolved = resolveAttachmentPathById({
        attachmentsDir,
        attachmentId,
      });
      expect(resolved).toBe(pngPath);
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("returns null when no attachment file exists for the id", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-store-"),
    );
    try {
      const resolved = resolveAttachmentPathById({
        attachmentsDir,
        attachmentId: "thread-1-missing",
      });
      expect(resolved).toBeNull();
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });
});
