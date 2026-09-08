import type { EnvironmentId } from "@t3tools/contracts";
import type { ServerUpdateStage, ServerUpdateState } from "@t3tools/client-runtime/state/server";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { type ComponentProps, useRef, useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { manualServerUpdateCommand, type ServerUpdateCapability } from "~/versionSkew";
import { serverUpdateConfirmation } from "./ServerUpdateAction.logic";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog";
import { toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

// The wire "installing" stage is a sub-second launcher handoff, so the UI
// folds it into the download phase; everything after the handoff is the
// restart the user is actually waiting through.
const UPDATE_STAGE_LABELS: Record<ServerUpdateStage, string> = {
  downloading: "Downloading…",
  installing: "Downloading…",
  resuming: "Restarting…",
};
const pendingUpdateEnvironmentIds = new Set<EnvironmentId>();

export function serverUpdateStageLabel(stage: ServerUpdateStage): string {
  return UPDATE_STAGE_LABELS[stage];
}

function updateFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Server update failed.";
}

export interface ServerUpdateTarget {
  readonly environmentId: EnvironmentId;
  readonly serverLabel: string;
  readonly selfUpdate: ServerUpdateCapability | null;
  /** The desktop app supervising this server accepts remote update
      requests (capabilities.desktopAppUpdate). */
  readonly desktopAppUpdate?: boolean;
  /** The server can durably continue running provider turns after updating. */
  readonly threadContinuation?: boolean;
  readonly targetVersion: string;
  readonly continueThreadsAfterServerUpdate?: boolean;
}

type UpdateButtonProps = Pick<ComponentProps<typeof Button>, "variant" | "size"> & {
  readonly label?: string;
};

/** The app can start this server's update itself; other servers need manual steps. */
export function canUpdateFromApp(
  target: Pick<ServerUpdateTarget, "selfUpdate" | "desktopAppUpdate">,
): boolean {
  return (
    target.selfUpdate !== null &&
    target.selfUpdate !== "service-migration" &&
    (target.selfUpdate !== "desktop-managed" || target.desktopAppUpdate === true)
  );
}

function continuesRunningThreads(target: ServerUpdateTarget): boolean {
  return Boolean(target.threadContinuation && target.continueThreadsAfterServerUpdate);
}

/**
 * Updates servers after one confirmation covering all of them. Servers with an
 * update already in flight are skipped; each remaining server reports its own
 * result.
 */
function useServerUpdates() {
  const updateServer = useAtomCommand(serverEnvironment.updateServer, { reportFailure: false });
  const readHostActivity = useAtomCommand(serverEnvironment.hostActivity, {
    reportFailure: false,
  });
  const updateOne = async (target: ServerUpdateTarget, failureTitle: string) => {
    const { environmentId, serverLabel, selfUpdate, targetVersion } = target;
    try {
      const result = await updateServer({
        environmentId,
        input: {
          targetVersion,
          ...(continuesRunningThreads(target) ? { continueRunningThreads: true } : {}),
        },
      });
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return;
        throw squashAtomCommandFailure(result);
      }
      toastManager.add({
        type: "success",
        title: `${serverLabel} updated`,
        description:
          selfUpdate === "desktop-managed"
            ? `Desktop app relaunched on ${result.value.targetVersion}.`
            : `Reconnected on @styal/cli@${result.value.targetVersion}.`,
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: failureTitle,
        description: updateFailureMessage(error),
      });
    }
  };
  return async (targets: ReadonlyArray<ServerUpdateTarget>) => {
    const claimed = targets.filter(
      (target) => !pendingUpdateEnvironmentIds.has(target.environmentId),
    );
    if (claimed.length === 0) return;
    for (const target of claimed) pendingUpdateEnvironmentIds.add(target.environmentId);
    try {
      // This is the only confirmation in the flow; the remote machines restart
      // without asking anyone there, so work started from any client counts.
      const activities = await Promise.all(
        claimed.map(async ({ environmentId }) => {
          const activity = await readHostActivity({ environmentId, input: {} });
          return activity._tag === "Success" ? activity.value : null;
        }),
      );
      const confirmation = serverUpdateConfirmation(
        claimed.map((target, index) => ({
          serverLabel: target.serverLabel,
          activity: activities[index] ?? null,
          desktopApp: target.selfUpdate === "desktop-managed",
          continueRunningThreads: continuesRunningThreads(target),
        })),
      );
      // No themed host mounted (undefined) means proceed: the click itself
      // was the request.
      if (confirmation !== null && !((await requestConfirmDialog(confirmation)) ?? true)) {
        return;
      }
      await Promise.all(
        claimed.map((target) =>
          updateOne(
            target,
            claimed.length === 1 ? "Server update failed" : `${target.serverLabel} update failed`,
          ),
        ),
      );
    } finally {
      for (const target of claimed) pendingUpdateEnvironmentIds.delete(target.environmentId);
    }
  };
}

/** Updates eligible machines independently; manual paths remain in the machine list. */
export function ServerUpdatesAction({
  targets,
  label = "Update all",
  variant = "outline",
  size = "xs",
}: UpdateButtonProps & {
  readonly targets: ReadonlyArray<ServerUpdateTarget>;
}) {
  const update = useServerUpdates();
  const pending = useRef(false);
  const [isPending, setIsPending] = useState(false);
  const eligible = targets.filter(canUpdateFromApp);
  const handleUpdate = async () => {
    if (pending.current) return;
    pending.current = true;
    setIsPending(true);
    try {
      await update(eligible);
    } finally {
      pending.current = false;
      setIsPending(false);
    }
  };
  return (
    <Button
      size={size}
      variant={variant}
      disabled={isPending || eligible.length === 0}
      onClick={() => void handleUpdate()}
    >
      {label}
    </Button>
  );
}

/**
 * One-row status for an in-flight server update: "Downloading…" then
 * "Restarting…". The update is a wait, not a warning: a single pulsing dot
 * and label, no step rail, no versions. Failure turns the row red with the
 * rollback reason.
 */
export function ServerUpdateProgress({
  state,
  className,
}: {
  readonly state: Exclude<ServerUpdateState, { status: "idle" }>;
  readonly className?: string;
}) {
  if (state.status === "failed") {
    return (
      <div
        className={cn("mt-1 flex min-w-0 items-center gap-2 text-xs text-destructive", className)}
        role="alert"
      >
        <span className="size-1.5 shrink-0 rounded-full bg-destructive" aria-hidden="true" />
        <Tooltip>
          <TooltipTrigger render={<span className="min-w-0 truncate">{state.message}</span>} />
          <TooltipPopup side="top" className="max-w-80">
            {state.message}
          </TooltipPopup>
        </Tooltip>
      </div>
    );
  }
  return (
    <div
      className={cn("mt-1 flex items-center gap-2 text-xs font-medium text-foreground", className)}
    >
      <span
        className="size-1.5 shrink-0 animate-status-pulse rounded-full bg-current"
        aria-hidden="true"
      />
      <span>{serverUpdateStageLabel(state.stage)}</span>
    </div>
  );
}

/**
 * Offers the update path advertised by a version-skewed server. Self-updates
 * delegate their full lifecycle to client-runtime so this component can
 * unmount during reconnect without losing operation state.
 */
export function ServerUpdateAction({
  environmentId,
  serverLabel,
  selfUpdate,
  desktopAppUpdate = false,
  threadContinuation = false,
  targetVersion,
  label = "Update",
  variant = "outline",
  size = "xs",
}: Omit<ServerUpdateTarget, "continueThreadsAfterServerUpdate"> & UpdateButtonProps) {
  const continueThreadsAfterServerUpdate = useEnvironmentSettings(
    environmentId,
    (settings) => settings.continueThreadsAfterServerUpdate,
  );
  const update = useServerUpdates();
  const { copyToClipboard } = useCopyToClipboard<{ description: string }>({
    target: "command",
    onCopy: ({ description }) => {
      toastManager.add({
        type: "success",
        title: "Command copied",
        description,
      });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Could not copy command",
        description: error.message,
      });
    },
  });

  const handleUpdate = () =>
    update([
      {
        environmentId,
        serverLabel,
        selfUpdate,
        desktopAppUpdate,
        threadContinuation,
        targetVersion,
        continueThreadsAfterServerUpdate,
      },
    ]);

  if (selfUpdate === "desktop-managed" && !desktopAppUpdate) {
    return (
      <span className="text-muted-foreground text-xs">
        Update the desktop app on that machine to update this server.
      </span>
    );
  }

  if (selfUpdate === null || selfUpdate === "service-migration") {
    const serviceMigration = selfUpdate === "service-migration";
    const command = manualServerUpdateCommand(
      targetVersion,
      serviceMigration ? "service" : "foreground",
    );
    return (
      <Dialog>
        <DialogTrigger render={<Button size={size} variant={variant} />}>
          Update instructions
        </DialogTrigger>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Update {serverLabel}</DialogTitle>
            <DialogDescription>
              {serviceMigration
                ? "This server needs a one-time service migration before it can update from the app."
                : "This server does not support in-app updates. How you update it depends on how it was started."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-5 text-sm">
            <p className="text-muted-foreground">
              Let active work finish, then use a separate terminal or SSH session on {serverLabel}.
              Keep the same data directory and connection settings, including any custom port or
              Tailscale configuration.
            </p>
            <section className="space-y-2">
              <p className="text-muted-foreground">
                {serviceMigration ? (
                  <>
                    This updates and restarts the background service, enabling future in-app
                    updates. For a custom data directory, add your existing <code>--base-dir</code>{" "}
                    option.
                  </>
                ) : (
                  <>
                    If you start styal from a terminal, stop the existing server, then run this with
                    the same startup options. It starts a foreground server; it does not replace a
                    running instance.
                  </>
                )}
              </p>
              <div className="flex items-center gap-3 rounded-md bg-muted p-3">
                <code className="min-w-0 flex-1 break-all text-xs">{command}</code>
                <Button
                  size="xs"
                  variant="outline"
                  className="shrink-0"
                  aria-label={
                    serviceMigration ? "Copy service update command" : "Copy start command"
                  }
                  onClick={() =>
                    copyToClipboard(command, {
                      description: serviceMigration
                        ? `Run this in a separate terminal on ${serverLabel} after active work finishes. It restarts the background service.`
                        : `For a terminal-launched server on ${serverLabel}, stop the existing process first, then run this with the same startup options.`,
                    })
                  }
                >
                  Copy
                </Button>
              </div>
            </section>
            {!serviceMigration && (
              <p className="text-muted-foreground">
                If styal runs as a service or in a container, update it through your existing
                deployment method.
              </p>
            )}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    );
  }

  return (
    <Button size={size} variant={variant} onClick={() => void handleUpdate()}>
      {label}
    </Button>
  );
}
