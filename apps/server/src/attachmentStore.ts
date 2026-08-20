// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { ChatAttachment } from "@t3tools/contracts";

import {
  normalizeAttachmentRelativePath,
  resolveAttachmentRelativePath,
} from "./attachmentPaths.ts";
import { inferImageExtension, SAFE_IMAGE_FILE_EXTENSIONS } from "./imageMime.ts";

const ATTACHMENT_FILENAME_EXTENSIONS = [...SAFE_IMAGE_FILE_EXTENSIONS, ".bin"];
const ATTACHMENT_ID_THREAD_SEGMENT_MAX_CHARS = 80;
const ATTACHMENT_BASENAME_MAX_BYTES = 180;
const ATTACHMENT_ID_THREAD_SEGMENT_PATTERN = "[a-z0-9_]+(?:-[a-z0-9_]+)*";
const ATTACHMENT_ID_UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ATTACHMENT_ID_PATTERN = new RegExp(
  `^(${ATTACHMENT_ID_THREAD_SEGMENT_PATTERN})-(${ATTACHMENT_ID_UUID_PATTERN})$`,
  "i",
);

export function toSafeThreadAttachmentSegment(threadId: string): string | null {
  const segment = threadId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, ATTACHMENT_ID_THREAD_SEGMENT_MAX_CHARS)
    .replace(/[-_]+$/g, "");
  if (segment.length === 0) {
    return null;
  }
  return segment;
}

export function createAttachmentId(threadId: string): string | null {
  const threadSegment = toSafeThreadAttachmentSegment(threadId);
  if (!threadSegment) {
    return null;
  }
  return `${threadSegment}-${NodeCrypto.randomUUID()}`;
}

export function parseThreadSegmentFromAttachmentId(attachmentId: string): string | null {
  const normalizedId = normalizeAttachmentRelativePath(attachmentId);
  if (!normalizedId || normalizedId.includes("/") || normalizedId.includes(".")) {
    return null;
  }
  const match = normalizedId.match(ATTACHMENT_ID_PATTERN);
  if (!match) {
    return null;
  }
  return match[1]?.toLowerCase() ?? null;
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

/** Keeps the user-facing stem with a trusted extension as one cross-platform path segment. */
export function toSafeAttachmentBasename(input: {
  readonly name: string;
  readonly extension: string;
}): string {
  const basename = NodePath.posix.basename(input.name.replace(/\\/g, "/"));
  const invalidCharacters = new Set('<>:"/\\|?*');
  const sanitized = [...basename]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f || invalidCharacters.has(character)
        ? "_"
        : character;
    })
    .join("")
    .replace(/[. ]+$/g, "")
    .trim();
  const usable = sanitized.length > 0 && sanitized !== "." && sanitized !== "..";
  const candidate = usable ? sanitized : "attachment";
  const originalExtension = NodePath.extname(candidate);
  const originalStem = originalExtension
    ? candidate.slice(0, -originalExtension.length)
    : candidate;
  const reservedStem = originalStem.split(".", 1)[0]?.toLowerCase() ?? "";
  const windowsSafeStem = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/.test(reservedStem)
    ? `_${originalStem}`
    : originalStem;
  const extension = /^\.[a-z0-9]{1,16}$/i.test(input.extension) ? input.extension : ".bin";
  return `${truncateUtf8(
    windowsSafeStem,
    ATTACHMENT_BASENAME_MAX_BYTES - Buffer.byteLength(extension),
  )}${extension}`;
}

function imageAttachmentRelativePaths(attachment: ChatAttachment): [string, string] {
  const extension = inferImageExtension({
    mimeType: attachment.mimeType,
    fileName: attachment.name,
  });
  const basename = toSafeAttachmentBasename({
    name: attachment.name,
    extension,
  });
  return [`${attachment.id}/${basename}`, `${attachment.id}${extension}`];
}

export function attachmentRelativePath(attachment: ChatAttachment): string {
  switch (attachment.type) {
    case "image": {
      return imageAttachmentRelativePaths(attachment)[0];
    }
  }
}

/** Current and legacy paths that may represent the same persisted attachment. */
export function attachmentRelativePaths(attachment: ChatAttachment): ReadonlyArray<string> {
  switch (attachment.type) {
    case "image":
      return imageAttachmentRelativePaths(attachment);
  }
}

export function resolveAttachmentPath(input: {
  readonly attachmentsDir: string;
  readonly attachment: ChatAttachment;
}): string | null {
  const relativePaths = attachmentRelativePaths(input.attachment);
  const preferredPath = resolveAttachmentRelativePath({
    attachmentsDir: input.attachmentsDir,
    relativePath: relativePaths[0]!,
  });
  if (!preferredPath || NodeFS.existsSync(preferredPath)) return preferredPath;

  for (const relativePath of relativePaths.slice(1)) {
    const legacyPath = resolveAttachmentRelativePath({
      attachmentsDir: input.attachmentsDir,
      relativePath,
    });
    if (legacyPath && NodeFS.existsSync(legacyPath)) return legacyPath;
  }
  return preferredPath;
}

export function resolveAttachmentPathById(input: {
  readonly attachmentsDir: string;
  readonly attachmentId: string;
}): string | null {
  const normalizedId = normalizeAttachmentRelativePath(input.attachmentId);
  if (!normalizedId || normalizedId.includes("/") || normalizedId.includes(".")) {
    return null;
  }
  const namedDirectory = resolveAttachmentRelativePath({
    attachmentsDir: input.attachmentsDir,
    relativePath: normalizedId,
  });
  if (namedDirectory) {
    try {
      if (NodeFS.lstatSync(namedDirectory).isDirectory()) {
        const entries = NodeFS.readdirSync(namedDirectory);
        if (entries.length === 1) {
          const namedPath = resolveAttachmentRelativePath({
            attachmentsDir: input.attachmentsDir,
            relativePath: `${normalizedId}/${entries[0]!}`,
          });
          if (namedPath && NodeFS.lstatSync(namedPath).isFile()) return namedPath;
        }
      }
    } catch {
      // Fall through to the legacy flat-file layout.
    }
  }
  for (const extension of ATTACHMENT_FILENAME_EXTENSIONS) {
    const maybePath = resolveAttachmentRelativePath({
      attachmentsDir: input.attachmentsDir,
      relativePath: `${normalizedId}${extension}`,
    });
    if (maybePath && NodeFS.existsSync(maybePath)) {
      return maybePath;
    }
  }
  return null;
}

export function parseAttachmentIdFromRelativePath(relativePath: string): string | null {
  const normalized = normalizeAttachmentRelativePath(relativePath);
  if (!normalized || normalized.includes("/")) {
    return null;
  }
  if (ATTACHMENT_ID_PATTERN.test(normalized)) {
    return normalized;
  }
  const extensionIndex = normalized.lastIndexOf(".");
  if (extensionIndex <= 0) {
    return null;
  }
  const id = normalized.slice(0, extensionIndex);
  return id.length > 0 && !id.includes(".") ? id : null;
}
