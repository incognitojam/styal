import type { DesktopUpdateState } from "@t3tools/contracts";
import { TriangleAlertIcon } from "lucide-react";
import { type ComponentProps, useCallback, useEffect, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateButtonTooltip,
  resolveDesktopUpdateButtonAction,
  shouldShowArm64IntelBuildWarning,
  shouldShowDesktopUpdateButton,
  shouldToastDesktopUpdateActionResult,
} from "../desktopUpdate.logic";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Popover, PopoverCreateHandle, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { SidebarMenuItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { DesktopUpdateStatusIcon } from "./DesktopUpdateStatusIcon";
import { SidebarUpdateReleaseNotes } from "./SidebarUpdateReleaseNotes";

type SidebarUpdatePopoverChangeDetails = Parameters<
  NonNullable<ComponentProps<typeof Popover>["onOpenChange"]>
>[1];
type SidebarUpdatePopoverHandle = ReturnType<typeof PopoverCreateHandle>;

export function shouldUseSidebarUpdateReleaseNotesPopover(
  showUpdateDetails: boolean,
  state: DesktopUpdateState | null,
): boolean {
  return showUpdateDetails && state?.channel === "nightly" && state.releaseNotes.length > 0;
}

export function handleSidebarUpdateReleaseNotesPopoverOpenChange(
  _open: boolean,
  details: Pick<SidebarUpdatePopoverChangeDetails, "reason" | "cancel">,
): void {
  // The trigger is the update action, so its presses must not also toggle the Popover.
  if (details.reason === "trigger-press") details.cancel();
}

export function openSidebarUpdateReleaseNotesPopoverOnForwardTab(
  event: { readonly key: string; readonly shiftKey: boolean },
  handle: Pick<SidebarUpdatePopoverHandle, "open">,
  triggerId: string,
): void {
  if (event.key !== "Tab" || event.shiftKey) return;
  // Hover-open popovers do not manage focus. Promote this one before native Tab runs.
  flushSync(() => handle.open(triggerId));
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
  const [releaseNotesPopoverHandle] = useState(() => PopoverCreateHandle());
  const suppressReleaseNotesFocusOpen = useRef(false);
  const releaseNotesPopupRef = useRef<HTMLDivElement>(null);
  const releaseNotesTriggerId = useId();
  const showUpdateDetails = shouldShowDesktopUpdateButton(state);
  const showReleaseNotesPopover = shouldUseSidebarUpdateReleaseNotesPopover(
    showUpdateDetails,
    state,
  );
  useEffect(() => {
    if (!showReleaseNotesPopover) {
      releaseNotesPopoverHandle.close();
      return;
    }

    const trigger = document.getElementById(releaseNotesTriggerId);
    if (trigger?.matches(":focus-visible")) {
      releaseNotesPopoverHandle.open(releaseNotesTriggerId);
    }
  }, [releaseNotesPopoverHandle, releaseNotesTriggerId, showReleaseNotesPopover]);

  const handleAction = useCallback(async () => {
    const bridge = window.desktopBridge;
    if (!bridge || !state) return;
    if (isInteractionDisabled || action !== "install") return;

    setIsActionPending(true);

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

  const updateButton = (
    <button
      type="button"
      aria-label={tooltip}
      aria-disabled={isInteractionDisabled || undefined}
      className={cn(
        "inline-flex size-8 items-center justify-center rounded-full outline-hidden ring-ring transition-colors focus-visible:ring-2",
        isInteractionDisabled ? "cursor-not-allowed" : "cursor-pointer",
        "bg-sidebar-control-surface text-sidebar-foreground",
        !isInteractionDisabled && "hover:bg-sidebar-row-hover",
        isInteractionDisabled && "opacity-60",
      )}
      onClick={handleAction}
      onBlur={() => {
        suppressReleaseNotesFocusOpen.current = false;
      }}
      onFocus={(event) => {
        if (!showReleaseNotesPopover || !event.currentTarget.matches(":focus-visible")) return;
        if (suppressReleaseNotesFocusOpen.current) {
          suppressReleaseNotesFocusOpen.current = false;
          return;
        }
        flushSync(() => releaseNotesPopoverHandle.open(releaseNotesTriggerId));
      }}
      onKeyDown={(event) => {
        if (!showReleaseNotesPopover) return;
        openSidebarUpdateReleaseNotesPopoverOnForwardTab(
          event,
          releaseNotesPopoverHandle,
          releaseNotesTriggerId,
        );
      }}
    >
      <DesktopUpdateStatusIcon status="downloaded" downloadPercent={null} />
    </button>
  );

  return (
    <SidebarMenuItem className="ml-auto shrink-0">
      <Popover
        handle={releaseNotesPopoverHandle}
        onOpenChange={(open, details) => {
          if (open && !showReleaseNotesPopover) {
            details.cancel();
            return;
          }
          handleSidebarUpdateReleaseNotesPopoverOpenChange(open, details);
        }}
      >
        <Tooltip disabled={showReleaseNotesPopover}>
          <TooltipTrigger
            id={releaseNotesTriggerId}
            render={
              <PopoverTrigger
                {...(!showReleaseNotesPopover
                  ? {
                      "aria-controls": undefined,
                      "aria-expanded": undefined,
                      "aria-haspopup": undefined,
                    }
                  : {})}
                closeDelay={150}
                handle={releaseNotesPopoverHandle}
                id={releaseNotesTriggerId}
                openOnHover={showReleaseNotesPopover}
                render={updateButton}
              />
            }
          />
          {!showReleaseNotesPopover ? (
            <TooltipPopup
              align="center"
              side="top"
              variant={showUpdateDetails ? "glass" : "default"}
            >
              {tooltip}
            </TooltipPopup>
          ) : null}
        </Tooltip>
        {showReleaseNotesPopover && state ? (
          <PopoverPopup
            align="center"
            aria-label="Nightly update release notes"
            className="max-w-none text-balance shadow-xl shadow-black/25"
            initialFocus={false}
            onKeyDownCapture={(event) => {
              if (
                event.key === "Escape" &&
                releaseNotesPopupRef.current?.contains(document.activeElement)
              ) {
                suppressReleaseNotesFocusOpen.current = true;
              }
            }}
            ref={releaseNotesPopupRef}
            side="top"
            tooltipStyle
          >
            <SidebarUpdateReleaseNotes
              shell={window.desktopBridge}
              state={state}
              tooltip={tooltip}
            />
          </PopoverPopup>
        ) : null}
      </Popover>
    </SidebarMenuItem>
  );
}
