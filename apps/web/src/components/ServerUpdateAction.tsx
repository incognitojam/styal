import { useAtomValue } from "@effect/atom-react";
import {
  AuthEnvironmentMaintainScope,
  type AuthSessionState,
  sessionGrantsScope,
} from "@t3tools/contracts";
import type { AsyncResult } from "effect/reactivity";
import { environmentSession } from "~/state/session";
import type { EnvironmentId, ServerInstallation } from "@t3tools/contracts";
import type { ServerUpdateStage, ServerUpdateState } from "@t3tools/client-runtime/state/server";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { CircleArrowUpIcon } from "lucide-react";
import { type ComponentProps, useRef, useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { serverEnvironment, updateOutdatedServer } from "~/state/server";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useAtomCommand } from "~/state/use-atom-command";
import { manualServerUpdateCommand, type ServerUpdateCapability } from "~/versionSkew";
import { serverUpdateActivity, serverUpdateConfirmation } from "./ServerUpdateAction.logic";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";
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
  /** How a manually updated server was installed, when the server could prove it. */
  readonly installation?: ServerInstallation | undefined;
  /** The desktop app supervising this server accepts remote update
      requests (capabilities.desktopAppUpdate). */
  readonly desktopAppUpdate?: boolean;
  /** The server continues opted-in running turns after updating and reports
      which threads will continue, applying each project's setting. */
  readonly threadContinuation?: boolean;
  readonly targetVersion: string;
}

type UpdateButtonProps = Pick<ComponentProps<typeof Button>, "variant" | "size" | "className"> & {
  readonly label?: string;
  readonly appearance?: "button" | "icon";
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
  return target.threadContinuation === true;
}

/** What one server's update did. "skipped" covers a missing permission, an
    update already in flight, a cancelled confirmation, and an interrupted request. */
export type ServerUpdateOutcome =
  | { readonly status: "updated" | "skipped" }
  | { readonly status: "failed"; readonly message: string };

function serverUpdateHost(target: ServerUpdateTarget) {
  return {
    serverLabel: target.serverLabel,
    desktopApp: target.selfUpdate === "desktop-managed",
    continueRunningThreads: continuesRunningThreads(target),
  };
}

function useReadHostActivity() {
  return {
    host: useAtomCommand(serverEnvironment.hostActivity, { reportFailure: false }),
    desktop: useAtomCommand(serverEnvironment.desktopHostActivity, { reportFailure: false }),
  };
}

/** Reads each server's running work and describes what its update would interrupt. */
async function checkServerUpdateHosts(
  readHostActivity: ReturnType<typeof useReadHostActivity>,
  targets: ReadonlyArray<ServerUpdateTarget>,
) {
  const hosts = await Promise.all(
    targets.map(async (target) => {
      const request = { environmentId: target.environmentId, input: {} };
      const [result, desktopResult] = await Promise.all([
        readHostActivity.host(request),
        target.selfUpdate === "desktop-managed" ? readHostActivity.desktop(request) : null,
      ]);
      return {
        ...serverUpdateHost(target),
        activity: result._tag === "Success" ? result.value : null,
        ...(target.selfUpdate === "desktop-managed"
          ? {
              desktopActivity: desktopResult?._tag === "Success" ? desktopResult.value : null,
            }
          : {}),
      };
    }),
  );
  const activity = serverUpdateActivity(hosts);
  return { activity, confirmation: serverUpdateConfirmation(hosts, activity) };
}

/**
 * Checks servers for running work ahead of a confirmation the caller shows
 * itself, then passes `confirmed` to `useServerUpdates`.
 */
export function useServerUpdateCheck() {
  const readHostActivity = useReadHostActivity();
  return async (targets: ReadonlyArray<ServerUpdateTarget>) => {
    const checked =
      targets.length === 0 ? null : await checkServerUpdateHosts(readHostActivity, targets);
    // The first line repeats the question the caller's own confirmation asks.
    return {
      lines: checked?.confirmation?.message.split("\n").slice(1) ?? checked?.activity.lines ?? [],
      threadActivity: checked?.activity.threadActivity ?? [],
      interrupts: checked?.activity.interrupts ?? false,
    };
  };
}

/**
 * Updates servers after one confirmation covering all of them. Servers with an
 * update already in flight are skipped. Each server toasts its own result unless
 * `quiet`, and `onSettled` hears each outcome as it lands. The returned promise
 * settles once every update has finished, with one outcome per target.
 */
export function useServerUpdates() {
  const updateServer = useAtomCommand(serverEnvironment.updateServer, { reportFailure: false });
  const readHostActivity = useReadHostActivity();
  const updateOne = async (
    target: ServerUpdateTarget,
    quiet: boolean,
    confirmed: boolean,
  ): Promise<ServerUpdateOutcome> => {
    const { environmentId, serverLabel, selfUpdate, targetVersion } = target;
    if (!canUpdateServer(appAtomRegistry.get(environmentSession.sessionStateAtom(environmentId))))
      return { status: "skipped" };
    const result = await updateServer({
      environmentId,
      input: {
        targetVersion,
        confirmed,
        ...(continuesRunningThreads(target) ? { continueRunningThreads: true } : {}),
      },
    });
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return { status: "skipped" };
      const message = updateFailureMessage(squashAtomCommandFailure(result));
      if (!quiet) {
        toastManager.add({
          type: "error",
          title: `${serverLabel} update failed`,
          description: message,
        });
      }
      return { status: "failed", message };
    }
    if (!quiet) {
      toastManager.add({
        type: "success",
        title: `${serverLabel} updated`,
        description:
          selfUpdate === "desktop-managed"
            ? `Desktop app relaunched on ${result.value.targetVersion}.`
            : `Reconnected on @styal/cli@${result.value.targetVersion}.`,
      });
    }
    return { status: "updated" };
  };
  return async (
    targets: ReadonlyArray<ServerUpdateTarget>,
    {
      quiet = false,
      confirmed = false,
      onSettled,
    }: {
      readonly quiet?: boolean;
      /** The caller already confirmed, after showing `useServerUpdateCheck`'s result. */
      readonly confirmed?: boolean;
      readonly onSettled?: (target: ServerUpdateTarget, outcome: ServerUpdateOutcome) => void;
    } = {},
  ): Promise<ReadonlyArray<{ target: ServerUpdateTarget; outcome: ServerUpdateOutcome }>> => {
    const claimed = targets.filter(
      (target) =>
        canUpdateServer(
          appAtomRegistry.get(environmentSession.sessionStateAtom(target.environmentId)),
        ) && !pendingUpdateEnvironmentIds.has(target.environmentId),
    );
    const settle = (target: ServerUpdateTarget, outcome: ServerUpdateOutcome) => {
      onSettled?.(target, outcome);
      return { target, outcome };
    };
    const skipAll = (skipped: ReadonlyArray<ServerUpdateTarget>) =>
      skipped.map((target) => settle(target, { status: "skipped" }));
    const unclaimed = targets.filter((target) => !claimed.includes(target));
    if (claimed.length === 0) return skipAll(unclaimed);
    for (const target of claimed) pendingUpdateEnvironmentIds.add(target.environmentId);
    const result = await settlePromise(async () => {
      let explicitConsent = confirmed;
      if (!confirmed) {
        // The remote machines restart without asking anyone there, so work
        // started from any client counts.
        const { confirmation } = await checkServerUpdateHosts(readHostActivity, claimed);
        // Without a dialog host (undefined), only a safe check can proceed.
        if (
          confirmation !== null &&
          !(await requestConfirmDialog(confirmation.message, {
            confirmLabel: "Update",
            threadActivity: confirmation.threadActivity,
          }))
        ) {
          return skipAll(targets);
        }
        explicitConsent = confirmation !== null;
      }
      const updated = await Promise.all(
        claimed.map(async (target) =>
          settle(target, await updateOne(target, quiet, explicitConsent)),
        ),
      );
      return [...skipAll(unclaimed), ...updated];
    });
    for (const target of claimed) pendingUpdateEnvironmentIds.delete(target.environmentId);
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    return result.value;
  };
}

export function ServerUpdatesAction({
  targets,
  label = "Update all",
  variant = "outline",
  size = "xs",
  className,
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
    await settlePromise(() => update(eligible));
    pending.current = false;
    setIsPending(false);
  };
  return (
    <Button
      size={size}
      variant={variant}
      className={className}
      disabled={isPending || eligible.length === 0}
      onClick={() => void handleUpdate()}
    >
      {isPending ? <Spinner aria-hidden="true" /> : null}
      {label}
    </Button>
  );
}

export function canUpdateServer(
  result: AsyncResult.AsyncResult<AuthSessionState, unknown>,
): boolean {
  if (result._tag !== "Success" || !result.value.authenticated) return false;
  return sessionGrantsScope(result.value, AuthEnvironmentMaintainScope);
}

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
          <TooltipPopup side="top">{state.message}</TooltipPopup>
        </Tooltip>
      </div>
    );
  }
  return (
    <div
      className={cn("mt-1 flex items-center gap-2 text-xs font-medium text-foreground", className)}
    >
      <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />
      <span>{serverUpdateStageLabel(state.stage)}</span>
    </div>
  );
}

/** client-runtime owns self-updates so unmounting during reconnect preserves operation state. */
export function ServerUpdateAction({
  environmentId,
  serverLabel,
  selfUpdate,
  installation,
  desktopAppUpdate = false,
  threadContinuation = false,
  targetVersion,
  label = "Update",
  variant = "outline",
  size = "xs",
  className,
  appearance = "button",
}: ServerUpdateTarget & UpdateButtonProps) {
  const sessionStateAtom = environmentSession.sessionStateAtom(environmentId);
  const canUpdate = canUpdateServer(useAtomValue(sessionStateAtom));
  const update = useServerUpdates();
  const [isPending, setIsPending] = useState(false);
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
    // A second click must not clear the first click's pending state.
    if (pendingUpdateEnvironmentIds.has(environmentId)) return;
    setIsPending(true);
    await settlePromise(() =>
      update([
        {
          environmentId,
          serverLabel,
          selfUpdate,
          desktopAppUpdate,
          threadContinuation,
          targetVersion,
        },
      ]),
    );
    setIsPending(false);
  };

  if (selfUpdate === "desktop-managed" && !desktopAppUpdate) {
    return (
      <span className="text-muted-foreground text-xs">
        Update the desktop app on that machine to update this server.
      </span>
    );
  }

  if (selfUpdate === null || selfUpdate === "service-migration") {
    const serviceMigration = selfUpdate === "service-migration";
    const globalInstall = !serviceMigration && installation?.kind === "npm-global";
    const command = manualServerUpdateCommand(
      targetVersion,
      serviceMigration ? "service" : "foreground",
      installation,
    );
    const instructions = (
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Update {serverLabel}</DialogTitle>
          <DialogDescription>
            {serviceMigration
              ? "This server needs a one-time service migration before it can update from the app."
              : "This server does not support in-app updates. How you update it depends on how it was started."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <p className="text-muted-foreground text-sm">
            Let active work finish, then use a separate terminal or SSH session on {serverLabel}.
            Keep the same data directory and connection settings, including any custom port or
            Tailscale configuration.
          </p>
          <section className="space-y-2">
            <p className="text-muted-foreground text-sm">
              {serviceMigration ? (
                <>
                  This updates and restarts the background service, enabling future in-app updates.
                  For a custom data directory, add your existing <code>--base-dir</code> option.
                </>
              ) : globalInstall ? (
                <>
                  This updates the <code>styal</code> command installed in{" "}
                  <code>{installation.prefix}</code>. Then stop the existing server and start it
                  again with the same startup options.
                </>
              ) : (
                <>
                  If you start styal from a terminal, stop the existing server, then run this with
                  the same startup options. It starts a foreground server; it does not replace a
                  running instance or update an installed <code>styal</code> command.
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
                  serviceMigration
                    ? "Copy service update command"
                    : globalInstall
                      ? "Copy update command"
                      : "Copy start command"
                }
                onClick={() =>
                  copyToClipboard(command, {
                    description: serviceMigration
                      ? `Run this in a separate terminal on ${serverLabel} after active work finishes. It restarts the background service.`
                      : globalInstall
                        ? `Run this on ${serverLabel}, then stop the existing server and start styal again with the same startup options.`
                        : `For a terminal-launched server on ${serverLabel}, stop the existing process first, then run this with the same startup options.`,
                  })
                }
              >
                Copy
              </Button>
            </div>
          </section>
          {!serviceMigration && (
            <p className="text-muted-foreground text-sm">
              If styal runs as a service or in a container, update it through your existing
              deployment method.
            </p>
          )}
        </DialogPanel>
      </DialogPopup>
    );
    if (appearance === "icon") {
      return (
        <Dialog>
          <Tooltip>
            <TooltipTrigger
              render={
                <DialogTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost-muted"
                      className={className}
                      aria-label={`Update instructions for ${serverLabel}`}
                    />
                  }
                />
              }
            >
              <CircleArrowUpIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">Update instructions</TooltipPopup>
          </Tooltip>
          {instructions}
        </Dialog>
      );
    }
    return (
      <Dialog>
        <DialogTrigger render={<Button size={size} variant={variant} className={className} />}>
          Update instructions
        </DialogTrigger>
        {instructions}
      </Dialog>
    );
  }

  const actionLabel = label;
  const onClick = () => void handleUpdate();

  const disabled = !canUpdate || isPending;

  if (appearance === "icon") {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost-muted"
              className={className}
              aria-label={`${actionLabel} for ${serverLabel}`}
              disabled={disabled}
              onClick={onClick}
            />
          }
        >
          {isPending ? <Spinner size="sm" /> : <CircleArrowUpIcon className="size-3.5" />}
        </TooltipTrigger>
        <TooltipPopup side="top">{actionLabel}</TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Button
      size={size}
      variant={variant}
      className={className}
      disabled={disabled}
      onClick={onClick}
    >
      {isPending ? <Spinner aria-hidden="true" /> : null}
      {actionLabel}
    </Button>
  );
}

/** Read the host descriptor's version because the host never delivers server config. */
export function OutdatedServerUpdateAction({
  environmentId,
  serverLabel,
  fromVersion,
  targetVersion,
  label = "Update",
}: {
  readonly environmentId: EnvironmentId;
  readonly serverLabel: string;
  readonly fromVersion: string | undefined;
  readonly targetVersion: string;
  readonly label?: string;
}) {
  const update = useAtomCommand(updateOutdatedServer, { reportFailure: false });
  const handleUpdate = async () => {
    if (pendingUpdateEnvironmentIds.has(environmentId)) return;
    pendingUpdateEnvironmentIds.add(environmentId);
    const confirmed = await requestConfirmDialog(
      `Update the ${serverLabel} server?\nCould not check this outdated server for running work. Running threads and terminals may be interrupted.`,
      { confirmLabel: "Update" },
    );
    if (confirmed !== true) {
      pendingUpdateEnvironmentIds.delete(environmentId);
      return;
    }
    const result = await update({
      environmentId,
      input: { targetVersion, confirmed },
      ...(fromVersion === undefined ? {} : { fromVersion }),
    });
    pendingUpdateEnvironmentIds.delete(environmentId);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      toastManager.add({
        type: "error",
        title: `${serverLabel} update failed`,
        description: updateFailureMessage(squashAtomCommandFailure(result)),
      });
      return;
    }
    toastManager.add({
      type: "success",
      title: `${serverLabel} updated`,
      description: `Reconnected on @styal/cli@${result.value.targetVersion}.`,
    });
  };
  return (
    <Button size="xs" variant="outline" onClick={() => void handleUpdate()}>
      {label}
    </Button>
  );
}
