import { RefreshIcon } from "~/components/ui/refresh-icon";
import { CircleArrowUpIcon, DownloadIcon, RotateCwIcon, TriangleAlertIcon } from "lucide-react";
import type { AnimationEventHandler } from "react";

const DOWNLOAD_PROGRESS_RADIUS = 11;
const DOWNLOAD_PROGRESS_CIRCUMFERENCE = 2 * Math.PI * DOWNLOAD_PROGRESS_RADIUS;

export type DesktopUpdateStatusIconState =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "failed"
  | "everything";

function DesktopUpdateAvailableIcon() {
  return (
    <span className="relative grid size-4 place-items-center">
      <DownloadIcon className="size-4" />
      <span
        aria-hidden="true"
        className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-current ring-2 ring-sidebar-control-surface"
      />
    </span>
  );
}

function DesktopUpdateDownloadingIcon({ percent }: { readonly percent: number | null }) {
  // Unknown progress draws an empty ring: no spinning, which would repaint every frame.
  const normalizedPercent =
    typeof percent === "number" && Number.isFinite(percent)
      ? Math.min(100, Math.max(0, percent))
      : 0;
  const progressOffset = DOWNLOAD_PROGRESS_CIRCUMFERENCE * (1 - normalizedPercent / 100);

  return (
    <span className="relative grid size-8 place-items-center">
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 size-full -rotate-90"
        viewBox="0 0 32 32"
      >
        <circle
          cx="16"
          cy="16"
          r={DOWNLOAD_PROGRESS_RADIUS}
          fill="none"
          className="stroke-current/22"
          strokeWidth="1.5"
        />
        <circle
          cx="16"
          cy="16"
          r={DOWNLOAD_PROGRESS_RADIUS}
          fill="none"
          stroke="currentColor"
          strokeDasharray={DOWNLOAD_PROGRESS_CIRCUMFERENCE}
          strokeDashoffset={progressOffset}
          strokeLinecap="round"
          strokeWidth="2"
          className="stroke-current transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none"
        />
      </svg>
      <DownloadIcon className="size-3.5" />
    </span>
  );
}

export function DesktopUpdateStatusIcon({
  downloadPercent,
  isCheckAnimating,
  onCheckAnimationIteration,
  status,
}: {
  readonly downloadPercent?: number | null;
  readonly isCheckAnimating?: boolean;
  readonly onCheckAnimationIteration?: AnimationEventHandler<SVGSVGElement>;
  readonly status: DesktopUpdateStatusIconState;
}) {
  if (status === "available") return <DesktopUpdateAvailableIcon />;
  if (status === "downloading") {
    return <DesktopUpdateDownloadingIcon percent={downloadPercent ?? null} />;
  }
  if (status === "downloaded") return <RotateCwIcon className="size-4" />;
  if (status === "failed") return <TriangleAlertIcon className="size-4" />;
  if (status === "everything") return <CircleArrowUpIcon className="size-4" />;

  return (
    <RefreshIcon
      className="size-4"
      refreshing={status === "checking" && isCheckAnimating === true}
      onAnimationIteration={onCheckAnimationIteration}
    />
  );
}
