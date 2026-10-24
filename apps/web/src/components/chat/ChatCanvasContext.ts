import { createContext, useContext } from "react";
import type { ChatCanvasPreview, resolveChatCanvasLayout } from "./chatCanvasLayout";
import type {
  PreviewMiniPlayerFrame,
  PreviewMiniPlayerObstacles,
} from "../preview/previewMiniPlayerLayout";
import type { PreviewMiniPlayerPosition } from "~/previewMiniPlayerStore";

export const ChatCanvasContext = createContext<{
  container: { width: number; height: number };
  lane: { padding: number; minChatWidth: number };
  layout: ReturnType<typeof resolveChatCanvasLayout>;
  /** Where the floating preview would render if dragged to `position`, after lanes and obstacles. */
  resolvePreviewFrame: (position: PreviewMiniPlayerPosition) => PreviewMiniPlayerFrame | null;
  previewKey: string | null;
  reportPreview: (preview: ChatCanvasPreview) => void;
  clearPreview: (key: string) => void;
  registerTimeline: (element: HTMLElement | null) => void;
  reportDetailsCard: (card: PreviewMiniPlayerObstacles["detailsCard"]) => void;
  detailsCardTopInset: number;
} | null>(null);

export const useChatCanvas = () => useContext(ChatCanvasContext);
