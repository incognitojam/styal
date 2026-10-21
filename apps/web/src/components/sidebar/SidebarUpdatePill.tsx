import type { DesktopBridge, DesktopUpdateState } from "@t3tools/contracts";
import { TriangleAlertIcon } from "lucide-react";
import { type ComponentProps, useEffect, useId, useRef, useState } from "react";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { flushSync } from "react-dom";
import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateDownloadedVersion,
  resolveDesktopUpdateButtonAction,
  shouldShowArm64IntelBuildWarning,
  shouldShowDesktopUpdateButton,
  shouldToastDesktopUpdateActionResult,
} from "../desktopUpdate.logic";
import { showDesktopUpdateDownloadedToast } from "../desktopUpdate.toast";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Popover, PopoverCreateHandle, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { SidebarMenuItem } from "../ui/sidebar";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { DesktopUpdateStatusIcon } from "./DesktopUpdateStatusIcon";
import { SidebarUpdateReleaseNotes } from "./SidebarUpdateReleaseNotes";
import { SidebarWebUpdatePill } from "./SidebarWebUpdatePill";
import { SidebarUpdateCapsule } from "./SidebarUpdateCapsule";
import { UpdateEverythingDialog } from "./UpdateEverythingDialog";
import type { UpdateEverythingConfirmation, UpdateRunLocalState } from "./updateEverything.logic";
import {
  clearSavedUpdateEverythingResult,
  saveUpdateEverythingResult,
  useUpdateEverythingRun,
} from "./updateEverythingRun";
import { type ReportLocalUpdateError, useUpdateEverything } from "./useUpdateEverything";

type SidebarUpdatePopoverChangeDetails = Parameters<
  NonNullable<ComponentProps<typeof Popover>["onOpenChange"]>
>[1];
type SidebarUpdatePopoverHandle = ReturnType<typeof PopoverCreateHandle>;

function shouldUseSidebarUpdateReleaseNotesPopover(
  showUpdateDetails: boolean,
  state: DesktopUpdateState | null,
): boolean {
  return showUpdateDetails && state?.channel === "nightly" && state.releaseNotes.length > 0;
}

function handleSidebarUpdateReleaseNotesPopoverOpenChange(
  _open: boolean,
  details: Pick<SidebarUpdatePopoverChangeDetails, "reason" | "cancel">,
): void {
  if (details.reason === "trigger-press") details.cancel();
}

function openSidebarUpdateReleaseNotesPopoverOnForwardTab(
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
    <Alert variant="warning">
      <TriangleAlertIcon />
      <AlertTitle>Intel build on Apple Silicon</AlertTitle>
      <AlertDescription>{description}</AlertDescription>
    </Alert>
  );
}

const toastUpdateError: ReportLocalUpdateError = (title, description) => {
  toastManager.add(stackedThreadToast({ type: "error", title, description }));
};

async function installLocalUpdate(
  bridge: DesktopBridge,
  reportError: ReportLocalUpdateError = toastUpdateError,
  expectedVersion?: string,
  confirmed = false,
): Promise<boolean> {
  try {
    const result =
      expectedVersion === undefined
        ? await bridge.installUpdate()
        : await bridge.installUpdate({ expectedVersion, confirmed });
    if (!result.accepted) {
      showDesktopUpdateDownloadedToast(bridge, result.state);
      return false;
    }
    const actionError = shouldToastDesktopUpdateActionResult(result)
      ? getDesktopUpdateActionError(result)
      : null;
    if (!actionError) return true;
    reportError("Could not install update", actionError);
    return false;
  } catch (error) {
    reportError(
      "Could not install update",
      error instanceof Error ? error.message : "An unexpected error occurred.",
    );
    return false;
  }
}

/**
 * The sidebar update button. Desktop updates download in the background, so with
 * only a local update the button restarts into it. When other machines' servers
 * or any providers are behind, one click updates everything: providers, then
 * servers, then this app last. Web shows its build refresh notice beside it.
 */
export function SidebarUpdatePill() {
  return isElectron ? (
    <SidebarUpdateControl />
  ) : (
    <>
      <SidebarWebUpdatePill />
      <SidebarUpdateControl />
    </>
  );
}

function SidebarUpdateControl() {
  const state = useDesktopUpdateState();
  const [isActionPending, setIsActionPending] = useState(false);
  const [isConfirmingEverything, setIsConfirmingEverything] = useState(false);
  const [activityCheck, setActivityCheck] = useState<UpdateEverythingConfirmation | null>(null);
  const action = state ? resolveDesktopUpdateButtonAction(state) : "none";
  const showsLocalUpdate = shouldShowDesktopUpdateButton(state);
  const localUpdateVersion =
    state && action === "install" ? getDesktopUpdateDownloadedVersion(state) : null;
  const everything = useUpdateEverything(localUpdateVersion);
  const isDownloading = state?.status === "downloading";
  const runsEverything = everything.hasUpdates && !isDownloading;
  const run = useUpdateEverythingRun();
  const isRunningEverything = run !== null;
  const showsEverything = runsEverything || isRunningEverything;
  const tooltip = runsEverything
    ? everything.summary
    : state
      ? getDesktopUpdateButtonTooltip(state)
      : "Restart to update";
  const isInteractionDisabled =
    isActionPending || isRunningEverything || (!runsEverything && state?.status === "checking");
  const [releaseNotesPopoverHandle] = useState(() => PopoverCreateHandle());
  const suppressReleaseNotesFocusOpen = useRef(false);
  const releaseNotesPopupRef = useRef<HTMLDivElement>(null);
  const releaseNotesTriggerId = useId();
  const showUpdateDetails = showsLocalUpdate && !showsEverything;
  const showReleaseNotesPopover =
    !isRunningEverything && shouldUseSidebarUpdateReleaseNotesPopover(showsLocalUpdate, state);
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

  const handleAction = async () => {
    if (isInteractionDisabled) return;
    if (runsEverything) {
      // The button shows the check in progress; a dialog opens only when something needs consent.
      setIsActionPending(true);
      const activity = await everything.checkActivity().catch((): UpdateEverythingConfirmation => ({
        lines: ["Could not check the servers for running work."],
        threadActivity: [],
        localVersion: null,
        interrupts: true,
        servers: "",
      }));
      if (!activity.interrupts) return runEverything(activity, false);
      setIsActionPending(false);
      setActivityCheck(activity);
      setIsConfirmingEverything(true);
      return;
    }
    const bridge = window.desktopBridge;
    if (!bridge || !state || action !== "install") return;
    setIsActionPending(true);
    void installLocalUpdate(bridge).finally(() => setIsActionPending(false));
  };

  const runEverything = async (activity: UpdateEverythingConfirmation, confirmed: boolean) => {
    const bridge = window.desktopBridge;
    setIsConfirmingEverything(false);
    setIsActionPending(true);
    const result = await settlePromise(() =>
      everything.run({
        ...(confirmed ? { confirmation: activity } : {}),
        ...(bridge && action === "install"
          ? {
              installLocal: (reportError) =>
                installLocalUpdate(
                  bridge,
                  reportError,
                  activity.localVersion ?? undefined,
                  confirmed,
                ),
            }
          : {}),
      }),
    );
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not update everything",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        }),
      );
    }
    setIsActionPending(false);
  };

  if (!showsLocalUpdate && !showsEverything) return null;

  const statusIcon = isActionPending ? (
    <Spinner size="md" aria-hidden="true" />
  ) : (
    <DesktopUpdateStatusIcon
      status={showsEverything ? "everything" : "downloaded"}
      downloadPercent={null}
    />
  );
  const confirmDialog = activityCheck ? (
    <UpdateEverythingDialog
      open={isConfirmingEverything}
      onOpenChange={setIsConfirmingEverything}
      summary={everything.summary}
      lines={everything.lines}
      skipped={everything.skipped}
      activity={activityCheck}
      onConfirm={() => void runEverything(activityCheck, true)}
    />
  ) : null;

  if (run !== null) {
    const local: UpdateRunLocalState =
      run.localVersion === null
        ? null
        : state?.status === "downloading"
          ? { status: "downloading", percent: state.downloadPercent }
          : { status: "waiting" };
    return (
      <SidebarMenuItem className="ml-auto flex min-w-0 flex-1">
        <SidebarUpdateCapsule
          run={run}
          local={local}
          icon={statusIcon}
          {...(run.localVersion === null && action === "install" && window.desktopBridge
            ? {
                onRestart: async () => {
                  saveUpdateEverythingResult({
                    localVersion: localUpdateVersion,
                    updatedServers: 0,
                    updatedProviders: 0,
                    failures: [],
                    restarting: [],
                  });
                  if (!(await installLocalUpdate(window.desktopBridge!))) {
                    clearSavedUpdateEverythingResult();
                  }
                },
              }
            : {})}
        />
        {confirmDialog}
      </SidebarMenuItem>
    );
  }

  const updateButton = (
    <button
      type="button"
      aria-label={tooltip}
      aria-disabled={isInteractionDisabled || undefined}
      className={cn(
        "inline-flex size-8 items-center justify-center rounded-full outline-hidden ring-ring transition-colors focus-visible:ring-2 focus-visible:ring-inset",
        isInteractionDisabled ? "cursor-not-allowed" : "cursor-pointer",
        "bg-update-surface text-update-foreground",
        !isInteractionDisabled && "hover:bg-update-surface-hover",
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
      {statusIcon}
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
              <span className="whitespace-pre-line">{tooltip}</span>
            </TooltipPopup>
          ) : null}
        </Tooltip>
        {showReleaseNotesPopover && state ? (
          <PopoverPopup
            align="center"
            aria-label="Nightly update release notes"
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
      {confirmDialog}
    </SidebarMenuItem>
  );
}
