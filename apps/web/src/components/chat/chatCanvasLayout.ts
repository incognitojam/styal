import {
  clampPreviewMiniPlayerPosition,
  resolvePreviewMiniPlayerFrame,
  type PreviewMiniPlayerFrame,
  type PreviewMiniPlayerObstacles,
} from "../preview/previewMiniPlayerLayout";
import type {
  PreviewMiniPlayerPosition,
  PreviewMiniPlayerSize,
  PreviewMiniPlayerState,
} from "~/previewMiniPlayerStore";

export interface ChatCanvasPreview {
  readonly key: string;
  readonly width: number | null;
  readonly position: PreviewMiniPlayerPosition | null;
  readonly source: PreviewMiniPlayerSize;
  readonly lastInteraction?: PreviewMiniPlayerState["lastInteraction"];
  /** A dragged or settling player moves freely over everything; obstacles apply once it comes to rest. */
  readonly dragging?: boolean;
}

const GAP = 12;
export const DETAILS_CARD_CLEARANCE = 32;

/**
 * The floating preview overlays the conversation and never moves or narrows
 * chat. It may cover messages, but keeps clear of the composer, the find bar,
 * and, unless a resize asks to fold it, the thread details card.
 */
export function resolveChatCanvasLayout({
  container,
  preview,
  padding = 48,
  maxChatWidth = 768,
  composerHeight = 0,
  detailsCard = null,
  findBar = null,
}: {
  container: PreviewMiniPlayerSize;
  preview: ChatCanvasPreview | null;
  padding?: number;
  maxChatWidth?: number;
  composerHeight?: number;
  detailsCard?: PreviewMiniPlayerObstacles["detailsCard"];
  findBar?: PreviewMiniPlayerObstacles["detailsCard"];
}) {
  const centeredWidth = Math.max(0, Math.min(maxChatWidth, container.width - padding * 2));
  const laneRight = detailsCard
    ? detailsCard.left - DETAILS_CARD_CLEARANCE
    : container.width - padding;
  const width = Math.max(0, Math.min(centeredWidth, laneRight - padding));
  const left = Math.max(padding, Math.min((container.width - width) / 2, laneRight - width));
  const chat = {
    left,
    width,
    insetStart: 0,
    insetEnd: Math.max(0, container.width - left * 2 - width),
  };
  const composer = { left: chat.left, right: chat.left + chat.width, height: composerHeight };
  // A resize may fold the details card, so only the composer and find bar bound it.
  const resizeObstacles: PreviewMiniPlayerObstacles = { composer, detailsCard: findBar };
  let frame: PreviewMiniPlayerFrame | null = null;
  if (preview && container.width > 0 && container.height > 0) {
    const card =
      detailsCard && findBar
        ? {
            left: Math.min(detailsCard.left, findBar.left),
            right: Math.max(detailsCard.right, findBar.right),
            bottom: Math.max(detailsCard.bottom, findBar.bottom),
          }
        : (detailsCard ?? findBar);
    const obstacles =
      preview.lastInteraction === "resize" ? resizeObstacles : { composer, detailsCard: card };
    frame = resolvePreviewMiniPlayerFrame({ ...preview, container, obstacles });
    // Choosing the nearest clear slot on every pointer move flips between slots
    // mid-drag, so obstacles only apply once the player is dropped.
    if (preview.dragging && preview.position) {
      frame = {
        ...frame,
        ...clampPreviewMiniPlayerPosition(preview.position, container, frame),
      };
      return { chat, frame, overlapsDetailsCard: false, resizeObstacles };
    }
    // With no slot clear of both, keep typing usable and let the card fold above the player.
    if (
      frame.x < composer.right &&
      frame.x + frame.width > composer.left &&
      frame.y + frame.height > container.height - composer.height
    ) {
      frame = {
        ...frame,
        ...clampPreviewMiniPlayerPosition(frame, container, frame, resizeObstacles),
      };
    }
    // New players start in the bottom-right corner, below any details card.
    if (preview.position === null) {
      frame = {
        ...frame,
        ...clampPreviewMiniPlayerPosition(
          { x: frame.x, y: container.height - frame.height - GAP },
          container,
          frame,
          obstacles,
        ),
      };
    }
  }
  const overlapsDetailsCard = Boolean(
    frame &&
    detailsCard &&
    frame.x < detailsCard.right &&
    frame.x + frame.width > detailsCard.left &&
    frame.y < detailsCard.bottom,
  );
  return { chat, frame, overlapsDetailsCard, resizeObstacles };
}
