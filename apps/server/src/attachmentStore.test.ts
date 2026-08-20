// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  attachmentRelativePath,
  createAttachmentId,
  createPendingAttachmentId,
  parseAttachmentUuid,
  planAttachmentClaim,
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPath,
  resolveAttachmentPathById,
  sweepStalePendingAttachments,
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

  it("reserves the pending attachment segment", () => {
    const pendingId = createPendingAttachmentId();
    expect(parseThreadSegmentFromAttachmentId(pendingId)).toBe("pending");
    expect(parseAttachmentUuid(pendingId)).toMatch(/^[a-f0-9-]{36}$/);
    expect(parseThreadSegmentFromAttachmentId(createAttachmentId("pending")!)).toBe("_pending");
    expect(parseThreadSegmentFromAttachmentId(createAttachmentId("pending_thread")!)).toBe(
      "pending_thread",
    );
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

  it("preserves a safe extension for generic files", () => {
    expect(
      attachmentRelativePath({
        type: "file",
        id: "thread-1-attachment",
        name: "docs/design spec.PDF",
        mimeType: "application/pdf",
        sizeBytes: 5,
      }),
    ).toBe("thread-1-attachment/design spec.pdf");
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

  it("plans pending attachment claims with direct filename lookups", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-claim-"),
    );
    try {
      const uuid = "00000000-0000-4000-8000-000000000001";
      const pendingPath = NodePath.join(attachmentsDir, `pending-${uuid}.png`);
      NodeFS.writeFileSync(pendingPath, Buffer.from("pixels"));

      const claim = planAttachmentClaim({
        attachmentsDir,
        threadId: "thread-1",
        attachment: {
          type: "image",
          id: `pending-${uuid}`,
          name: "screenshot.png",
          mimeType: "image/png",
          sizeBytes: 6,
        },
      });
      expect(claim).toMatchObject({
        ok: true,
        currentPath: pendingPath,
      });
      if (!claim.ok) {
        return;
      }
      expect(parseThreadSegmentFromAttachmentId(claim.finalId)).toBe("thread-1");
      expect(parseAttachmentUuid(claim.finalId)).not.toBe(uuid);
      expect(claim.finalPath).toBe(NodePath.join(attachmentsDir, claim.finalId, "screenshot.png"));
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("rejects thread-owned attachments even when thread segments collide", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-ownership-"),
    );
    try {
      const attachmentId = "a-b-00000000-0000-4000-8000-000000000003";
      NodeFS.writeFileSync(NodePath.join(attachmentsDir, `${attachmentId}.png`), "pixels");

      expect(
        planAttachmentClaim({
          attachmentsDir,
          threadId: "a b",
          attachment: {
            type: "image",
            id: attachmentId,
            name: "screenshot.png",
            mimeType: "image/png",
            sizeBytes: 6,
          },
        }),
      ).toEqual({
        ok: false,
        reason: "attachment must be a pending upload",
      });
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("removes expired pending and partial files without touching thread attachments", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-sweep-"),
    );
    try {
      const now = 1_800_000_000_000;
      const oldTimeSeconds = (now - 2 * 24 * 60 * 60 * 1000) / 1000;
      const uuid = "00000000-0000-4000-8000-000000000002";
      const pendingPath = NodePath.join(attachmentsDir, `pending-${uuid}.png`);
      const threadPath = NodePath.join(attachmentsDir, `thread-1-${uuid}.png`);
      const partialPath = NodePath.join(attachmentsDir, `${uuid}.part`);
      for (const filePath of [pendingPath, threadPath, partialPath]) {
        NodeFS.writeFileSync(filePath, Buffer.from("pixels"));
        NodeFS.utimesSync(filePath, oldTimeSeconds, oldTimeSeconds);
      }

      expect(sweepStalePendingAttachments({ attachmentsDir, nowMs: now })).toEqual({ deleted: 2 });
      expect(NodeFS.existsSync(pendingPath)).toBe(false);
      expect(NodeFS.existsSync(partialPath)).toBe(false);
      expect(NodeFS.existsSync(threadPath)).toBe(true);
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("does not expose generic files through the image asset lookup", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-store-"),
    );
    try {
      const attachmentId = "thread-1-attachment";
      const attachmentPath = NodePath.join(attachmentsDir, attachmentId, "notes.md");
      NodeFS.mkdirSync(NodePath.dirname(attachmentPath), { recursive: true });
      NodeFS.writeFileSync(attachmentPath, Buffer.from("# Notes"));

      expect(resolveAttachmentPathById({ attachmentsDir, attachmentId })).toBeNull();
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });
});
