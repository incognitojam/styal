import { TriangleAlertIcon } from "lucide-react";
import { useCallback, useState } from "react";
import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { ensureLocalApi } from "../../localApi";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateInstallConfirmationMessage,
  resolveDesktopUpdateButtonAction,
  shouldShowArm64IntelBuildWarning,
  shouldShowDesktopUpdateButton,
  shouldToastDesktopUpdateActionResult,
} from "../desktopUpdate.logic";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Separator } from "../ui/separator";
import { SidebarMenuItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { DesktopUpdateStatusIcon } from "./DesktopUpdateStatusIcon";

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
        <div className="text-sm leading-5 font-medium">{tooltip}</div>
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
  const tooltip = state ? getDesktopUpdateButtonTooltip(state) : "Restart to update";
  const isInteractionDisabled = isActionPending;

  const handleAction = useCallback(async () => {
    const bridge = window.desktopBridge;
    if (!bridge || !state) return;
    if (isInteractionDisabled || action !== "install") return;

    setIsActionPending(true);

    let confirmed = false;
    try {
      confirmed = await ensureLocalApi().dialogs.confirm(
        getDesktopUpdateInstallConfirmationMessage(state),
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
  }, [action, isInteractionDisabled, state]);

  if (!state || !shouldShowDesktopUpdateButton(state)) return null;

  return (
    <SidebarMenuItem className="ml-auto shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={tooltip}
              aria-disabled={isInteractionDisabled || undefined}
              className={cn(
                "relative inline-flex size-8 items-center justify-center rounded-full outline-hidden ring-ring transition-colors focus-visible:ring-2",
                "bg-update-surface text-update-foreground",
                isInteractionDisabled
                  ? "cursor-not-allowed opacity-60"
                  : "cursor-pointer hover:bg-update/12",
              )}
              onClick={handleAction}
            >
              <DesktopUpdateStatusIcon status="downloaded" downloadPercent={null} />
            </button>
          }
        />
        <TooltipPopup
          align="center"
          className={
            state.channel === "nightly" && state.releaseNotes.length > 0
              ? // pointer-events-auto overrides the positioner's pointer-events-none so the
                // release notes stay open (and scrollable) when the cursor moves into them.
                "pointer-events-auto max-w-none text-balance"
              : undefined
          }
          side="top"
          style={{
            background:
              "color-mix(in srgb, var(--update) 18%, color-mix(in srgb, var(--popover) var(--glass-opacity), transparent))",
            borderColor: "var(--update-foreground)",
          }}
          variant="glass"
        >
          <SidebarUpdateReleaseNotesTooltip state={state} tooltip={tooltip} />
        </TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}
