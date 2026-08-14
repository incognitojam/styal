import { ArrowUpCircleIcon, DownloadIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useState } from "react";
import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { ensureLocalApi } from "../../localApi";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  canCheckForUpdate,
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  resolveDesktopUpdateButtonTone,
  shouldShowArm64IntelBuildWarning,
  shouldToastDesktopUpdateActionResult,
} from "../desktopUpdate.logic";
import { showDesktopUpdateDownloadedToast } from "../desktopUpdate.toast";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Separator } from "../ui/separator";
import { SidebarMenuItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function keyReleaseNoteItems(items: ReadonlyArray<string>) {
  const occurrences = new Map<string, number>();
  return items.map((item) => {
    const occurrence = occurrences.get(item) ?? 0;
    occurrences.set(item, occurrence + 1);
    return { item, key: JSON.stringify([item, occurrence]) };
  });
}

function SidebarUpdateReleaseNotesTooltip({
  state,
  tooltip,
}: {
  readonly state: NonNullable<ReturnType<typeof useDesktopUpdateState>>;
  readonly tooltip: string;
}) {
  if (state.channel !== "nightly" || state.releaseNotes.length === 0) {
    return <>{tooltip}</>;
  }

  return (
    <div className="w-fit max-w-[min(24rem,calc(100vw-2rem))] text-left">
      <div className="px-1">
        {state.status === "available" ? (
          <div>
            <div className="whitespace-nowrap text-sm leading-5 font-medium">
              Update ready to download
            </div>
            {state.availableVersion ? (
              <div className="mt-0.5 text-xs leading-4 text-update-foreground">
                {state.availableVersion}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="text-sm leading-5 font-medium">{tooltip}</div>
        )}
      </div>
      <div className="max-h-[min(28rem,calc(100vh-6rem))] overflow-y-auto px-1 pt-4 pb-1">
        {state.releaseNotes.map((releaseNote, index) => (
          <div key={releaseNote.version}>
            {index > 0 && <Separator className="my-3 bg-border/60" />}
            <section>
              <h3 className="text-foreground text-xs leading-4 font-semibold">
                {index === 0 ? "What's changed" : `Changes in ${releaseNote.version}`}
              </h3>
              <ul className="mt-2 space-y-1.5 pl-4 text-xs leading-5 text-popover-foreground/90">
                {keyReleaseNoteItems(releaseNote.items).map(({ item, key }) => (
                  <li className="list-disc break-words" key={key}>
                    {item}
                  </li>
                ))}
              </ul>
            </section>
          </div>
        ))}
      </div>
    </div>
  );
}

const DOWNLOAD_RING_RADIUS = 11;
const DOWNLOAD_RING_CIRCUMFERENCE = 2 * Math.PI * DOWNLOAD_RING_RADIUS;

/**
 * A quiet progress ring for the background download. The main process only
 * broadcasts progress every 10% (shouldBroadcastDownloadProgress), so the stroke
 * is transitioned to glide between steps instead of jumping. Until the first
 * progress event lands the state carries 0, which would draw a zero-length arc,
 * so that spins a short arc rather than rendering an inert ring.
 */
function SidebarUpdateDownloadProgress({ percent }: { readonly percent: number | null }) {
  const isDeterminate = typeof percent === "number" && percent > 0;
  const dashOffset = isDeterminate
    ? DOWNLOAD_RING_CIRCUMFERENCE * (1 - Math.min(100, percent) / 100)
    : DOWNLOAD_RING_CIRCUMFERENCE * 0.75;

  return (
    <>
      <svg
        aria-hidden="true"
        className={cn(
          "absolute inset-0 size-8 -rotate-90 transform-gpu",
          !isDeterminate && "animate-spin motion-reduce:animate-none",
        )}
        viewBox="0 0 32 32"
      >
        <circle
          cx="16"
          cy="16"
          fill="none"
          r={DOWNLOAD_RING_RADIUS}
          stroke="color-mix(in oklab, var(--color-muted-foreground) 24%, transparent)"
          strokeWidth="2"
        />
        <circle
          className="fill-none stroke-current transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none"
          cx="16"
          cy="16"
          r={DOWNLOAD_RING_RADIUS}
          strokeDasharray={DOWNLOAD_RING_CIRCUMFERENCE}
          strokeDashoffset={dashOffset}
          strokeLinecap="round"
          strokeWidth="2"
        />
      </svg>
      <DownloadIcon className="size-3.5" />
    </>
  );
}

export function SidebarUpdateArchitectureWarning() {
  return isElectron ? <SidebarUpdateArchitectureWarningContent /> : null;
}

function SidebarUpdateArchitectureWarningContent() {
  const state = useDesktopUpdateState();
  const visible = shouldShowArm64IntelBuildWarning(state);
  const description = state && visible ? getArm64IntelBuildWarningDescription(state) : null;

  if (!visible || !description) return null;

  return (
    <Alert variant="warning" className="rounded-2xl border-warning/40 bg-warning/8 text-xs">
      <TriangleAlertIcon />
      <AlertTitle>Intel build on Apple Silicon</AlertTitle>
      <AlertDescription>{description}</AlertDescription>
    </Alert>
  );
}

export function SidebarUpdatePill() {
  return isElectron ? <SidebarUpdateControl /> : null;
}

function SidebarUpdateControl() {
  const state = useDesktopUpdateState();
  const [isActionPending, setIsActionPending] = useState(false);

  const action = state ? resolveDesktopUpdateButtonAction(state) : "none";
  const isDownloading = state?.status === "downloading";
  const isUpdateState = action !== "none" || isDownloading;
  const tone = resolveDesktopUpdateButtonTone(state);
  const tooltip = isUpdateState
    ? state
      ? getDesktopUpdateButtonTooltip(state)
      : "Update available"
    : state?.status === "checking"
      ? "Checking for updates…"
      : "Check for updates";
  const disabled = isUpdateState ? isDesktopUpdateButtonDisabled(state) : !canCheckForUpdate(state);

  const handleAction = useCallback(async () => {
    const bridge = window.desktopBridge;
    if (!bridge || !state) return;
    if (disabled || isActionPending) return;

    setIsActionPending(true);

    if (action === "download") {
      void bridge
        .downloadUpdate()
        .then((result) => {
          if (result.completed) {
            showDesktopUpdateDownloadedToast(bridge, result.state);
          }
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not download update",
              description: actionError,
            }),
          );
        })
        .catch((error) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not start update download",
              description: error instanceof Error ? error.message : "An unexpected error occurred.",
            }),
          );
        })
        .finally(() => setIsActionPending(false));
      return;
    }

    if (action === "install") {
      let confirmed = false;
      try {
        confirmed = await ensureLocalApi().dialogs.confirm(
          getDesktopUpdateInstallConfirmationMessage(state, navigator.platform),
        );
      } catch (error) {
        setIsActionPending(false);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not confirm update",
            description: error instanceof Error ? error.message : "Update confirmation failed.",
          }),
        );
        return;
      }
      if (!confirmed) {
        setIsActionPending(false);
        return;
      }
      void bridge
        .installUpdate()
        .then((result) => {
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not install update",
              description: actionError,
            }),
          );
        })
        .catch((error) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not install update",
              description: error instanceof Error ? error.message : "An unexpected error occurred.",
            }),
          );
        })
        .finally(() => setIsActionPending(false));
      return;
    }

    void bridge
      .checkForUpdate()
      .then((result) => {
        if (result.checked) return;
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not check for updates",
            description:
              result.state.message ?? "Automatic updates are not available in this build.",
          }),
        );
      })
      .catch((error) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not check for updates",
            description: error instanceof Error ? error.message : "Update check failed.",
          }),
        );
      })
      .finally(() => setIsActionPending(false));
  }, [action, disabled, isActionPending, state]);

  return (
    <SidebarMenuItem className="ml-auto shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={tooltip}
              aria-disabled={disabled || isActionPending || undefined}
              disabled={isActionPending || (!isUpdateState && disabled)}
              className={cn(
                "relative inline-flex size-8 items-center justify-center rounded-full outline-hidden ring-ring transition-colors focus-visible:ring-2",
                tone === "cta" &&
                  "bg-update-surface text-update-foreground enabled:cursor-pointer enabled:hover:bg-update/12 disabled:cursor-not-allowed disabled:opacity-60",
                // A manual retry keeps isActionPending true for the whole download, which
                // natively disables the button. Downloading must look the same either way,
                // so this branch deliberately omits the disabled dimming.
                tone === "quiet" && "cursor-default text-[var(--sidebar-icon-color)]",
                tone === "idle" &&
                  "text-[var(--sidebar-icon-color)] enabled:cursor-pointer enabled:hover:bg-sidebar-row-hover enabled:hover:text-sidebar-foreground disabled:cursor-not-allowed disabled:opacity-60",
              )}
              onClick={handleAction}
            >
              {action === "install" ? (
                <ArrowUpCircleIcon className="size-4" />
              ) : isDownloading ? (
                <SidebarUpdateDownloadProgress percent={state?.downloadPercent ?? null} />
              ) : isUpdateState ? (
                <DownloadIcon className="size-4" />
              ) : (
                <RefreshCwIcon
                  className={cn("size-4", state?.status === "checking" && "animate-spin")}
                />
              )}
            </button>
          }
        />
        <TooltipPopup
          align="center"
          className={
            isUpdateState && state?.channel === "nightly" && state.releaseNotes.length > 0
              ? // pointer-events-auto overrides the positioner's pointer-events-none so the
                // release notes stay open (and scrollable) when the cursor moves into them.
                "pointer-events-auto max-w-none text-balance"
              : undefined
          }
          side="top"
          style={
            tone === "cta"
              ? {
                  background:
                    "color-mix(in srgb, var(--update) 18%, color-mix(in srgb, var(--popover) var(--glass-opacity), transparent))",
                  borderColor: "var(--update-foreground)",
                }
              : undefined
          }
          variant={tone === "cta" ? "glass" : "default"}
        >
          {isUpdateState && state ? (
            <SidebarUpdateReleaseNotesTooltip state={state} tooltip={tooltip} />
          ) : (
            tooltip
          )}
        </TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}
