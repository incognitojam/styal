import type {
  ChatAttachment,
  ChatImageAttachment,
  OrchestrationMessageContext,
} from "@t3tools/contracts";
import { collectComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { imageMimeType } from "@t3tools/shared/image";

export const IMAGE_GRID_GAP = 8;
// Phones fill the bubble; this only bounds tiles on tablets, where half a bubble is huge.
const IMAGE_GRID_MAX_TILE = 240;
const IMAGE_GRID_MAX_TILES = 4;

export function imageGridTileSize(availableWidth: number) {
  return Math.max(
    0,
    Math.min(IMAGE_GRID_MAX_TILE, Math.floor((availableWidth - IMAGE_GRID_GAP) / 2)),
  );
}

export type MessageImageLayout<T> =
  | { readonly kind: "none" }
  | { readonly kind: "single"; readonly image: T }
  | { readonly kind: "grid"; readonly tiles: readonly T[]; readonly hiddenCount: number };

// One image keeps its large single layout; several share a 2x2 grid of square tiles, with the
// rest counted on the last tile.
export function messageImageLayout<T>(images: readonly T[]): MessageImageLayout<T> {
  if (images.length === 0) return { kind: "none" };
  if (images.length === 1) return { kind: "single", image: images[0]! };
  return {
    kind: "grid",
    tiles: images.slice(0, IMAGE_GRID_MAX_TILES),
    hiddenCount: Math.max(0, images.length - IMAGE_GRID_MAX_TILES),
  };
}

export function isImageAttachment(attachment: ChatAttachment): attachment is ChatImageAttachment {
  return attachment.type === "image" || imageMimeType(attachment) !== null;
}

// Images stay in the grid even when the text references them; other files referenced inline
// already show as chips in the text, so only the unreferenced ones are listed below the grid.
export function userMessageAttachmentLayout(message: {
  readonly text: string;
  readonly context?: OrchestrationMessageContext | undefined;
  readonly attachments: readonly ChatAttachment[];
}) {
  const referenceIds = new Set(
    collectComposerContextReferences(message.text).map((reference) => reference.contextId),
  );
  const inlineAttachmentIds = new Set(
    message.context?.records.flatMap((record) =>
      "attachmentId" in record && referenceIds.has(record.contextId) ? [record.attachmentId] : [],
    ),
  );
  return {
    gridImages: message.attachments.filter(isImageAttachment),
    listedAttachments: message.attachments.filter(
      (attachment) => !isImageAttachment(attachment) && !inlineAttachmentIds.has(attachment.id),
    ),
  };
}
