import { ArrowUpCircleIcon, DownloadIcon, RefreshCwIcon } from "lucide-react";
import type { AnimationEventHandler } from "react";

import { cn } from "../../lib/utils";

const DOWNLOAD_PROGRESS_RADIUS = 11;
const DOWNLOAD_PROGRESS_CIRCUMFERENCE = 2 * Math.PI * DOWNLOAD_PROGRESS_RADIUS;

export type DesktopUpdateStatusIconState =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded";

export function shouldShowDesktopUpdateCheckIcon({
  isAnimationLatched,
  isChecking,
  prefersReducedMotion,
}: {
  readonly isAnimationLatched: boolean;
  readonly isChecking: boolean;
  readonly prefersReducedMotion: boolean;
}): boolean {
  return isChecking || (isAnimationLatched && !prefersReducedMotion);
}

export function shouldContinueDesktopUpdateCheckAnimation({
  isChecking,
  prefersReducedMotion,
}: {
  readonly isChecking: boolean;
  readonly prefersReducedMotion: boolean;
}): boolean {
  return isChecking && !prefersReducedMotion;
}

function DesktopUpdateAvailableIcon() {
  return (
    <span className="relative grid size-4 place-items-center">
      <DownloadIcon className="size-4" />
      <span
        aria-hidden="true"
        className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-update-foreground ring-2 ring-update-surface"
      />
    </span>
  );
}

function DesktopUpdateDownloadingIcon({ percent }: { readonly percent: number | null }) {
  const isDeterminate = typeof percent === "number" && Number.isFinite(percent) && percent > 0;
  const progressOffset = isDeterminate
    ? DOWNLOAD_PROGRESS_CIRCUMFERENCE * (1 - Math.min(100, percent) / 100)
    : DOWNLOAD_PROGRESS_CIRCUMFERENCE * 0.75;

  return (
    <span className="relative grid size-8 place-items-center">
      <svg
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-0 size-full -rotate-90 transform-gpu",
          !isDeterminate && "animate-spin motion-reduce:animate-none",
        )}
        viewBox="0 0 32 32"
      >
        <circle
          cx="16"
          cy="16"
          r={DOWNLOAD_PROGRESS_RADIUS}
          fill="none"
          stroke="color-mix(in oklab, var(--color-muted-foreground) 24%, transparent)"
          strokeWidth="2"
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
          className="fill-none stroke-current transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none"
        />
      </svg>
      <DownloadIcon className="size-3.5" />
    </span>
  );
}

function DesktopUpdateDownloadedIcon() {
  return <ArrowUpCircleIcon className="size-4" />;
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
  if (status === "downloaded") return <DesktopUpdateDownloadedIcon />;

  return (
    <RefreshCwIcon
      className={cn("size-4", status === "checking" && isCheckAnimating && "animate-spin")}
      onAnimationIteration={onCheckAnimationIteration}
    />
  );
}
