import type { EnvironmentId } from "@t3tools/contracts";
import type { ServerUpdateStage, ServerUpdateState } from "@t3tools/client-runtime/state/server";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { manualServerUpdateCommand, type ServerUpdateCapability } from "~/versionSkew";
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
  targetVersion,
  label = "Update",
}: {
  readonly environmentId: EnvironmentId;
  readonly serverLabel: string;
  readonly selfUpdate: ServerUpdateCapability | null;
  readonly targetVersion: string;
  readonly label?: string;
}) {
  const updateServer = useAtomCommand(serverEnvironment.updateServer, {
    reportFailure: false,
  });
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

  const handleUpdate = async () => {
    if (pendingUpdateEnvironmentIds.has(environmentId)) {
      return;
    }
    pendingUpdateEnvironmentIds.add(environmentId);
    try {
      const result = await updateServer({
        environmentId,
        input: { targetVersion },
      });
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) {
          return;
        }
        toastManager.add({
          type: "error",
          title: "Server update failed",
          description: updateFailureMessage(squashAtomCommandFailure(result)),
        });
        return;
      }
      toastManager.add({
        type: "success",
        title: `${serverLabel} updated`,
        description: `Reconnected on @styal/cli@${result.value.targetVersion}.`,
      });
    } finally {
      pendingUpdateEnvironmentIds.delete(environmentId);
    }
  };

  if (selfUpdate === "desktop-managed") {
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
        <DialogTrigger render={<Button size="xs" variant="outline" />}>
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
    <Button size="xs" variant="outline" onClick={() => void handleUpdate()}>
      {label}
    </Button>
  );
}
