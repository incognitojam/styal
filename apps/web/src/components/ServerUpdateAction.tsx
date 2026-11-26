import type { ConfirmDialogOptions } from "@t3tools/contracts";
import { settleWithinGrace } from "@t3tools/shared/hostActivity";
import {
  serverUpdateActivity,
  serverUpdateConfirmation,
  serverUpdateCheckingMessage,
  serverUpdateSafeMessage,
} from "./ServerUpdateAction.logic";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { useAtomValue } from "@effect/atom-react";
import {
  AuthEnvironmentMaintainScope,
  type AuthSessionState,
  sessionGrantsScope,
} from "@t3tools/contracts";
import { managedUpdatesDenial } from "@t3tools/client-runtime/contract-labels";
import type { AsyncResult } from "effect/reactivity";
import { environmentSession } from "~/state/session";
import type {
  DesktopUpdateChannel,
  EnvironmentId,
  ServerInstallation,
  ServerSelfUpdateCapability,
} from "@t3tools/contracts";
import {
  serverUpdateFailureText,
  type ServerUpdateStage,
  type ServerUpdateState,
} from "@t3tools/client-runtime/state/server";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { CircleArrowUpIcon } from "lucide-react";
import { type ComponentProps, useRef, useState } from "react";
import { msg, T, useGT, useMessages } from "gt-react";
import { m, type MessageResolver } from "../i18n/messages";

import { requestConfirmDialog } from "~/confirmDialog";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { serverEnvironment, updateOutdatedServer } from "~/state/server";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useAtomCommand } from "~/state/use-atom-command";
import { useServerConfigs } from "~/state/entities";
import { useManagedPolicy } from "~/state/managedPolicy";
import { environmentPresentations } from "~/state/presentation";
import { ManagedControl } from "./ManagedPolicy";
import { manualServerUpdateCommand } from "~/versionSkew";
import { crossesReleaseTrack } from "@t3tools/shared/cliRelease";
import { Button } from "./ui/button";
import { toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const UPDATE_STAGE_LABELS: Record<ServerUpdateStage, string> = {
  downloading: msg("Downloading…"),
  installing: msg("Downloading…"),
  resuming: msg("Restarting…"),
};
const pendingUpdateEnvironmentIds = new Set<EnvironmentId>();

export function serverUpdateStageLabel(
  stage: ServerUpdateStage,
  resolve: MessageResolver = m,
): string {
  return resolve(UPDATE_STAGE_LABELS[stage]);
}

/** Why the environment's policy refuses server updates, read outside render. */
function readUpdatesDenial(environmentId: EnvironmentId): string | undefined {
  return managedUpdatesDenial(
    appAtomRegistry.get(environmentPresentations.serverConfigsAtom).get(environmentId)
      ?.managedPolicy,
    m,
  );
}

/** Hosts refuse a Stable/Nightly crossing outside a track switch, which checks the database first. */
function refusedCrossing(
  target: {
    readonly selfUpdate: ServerSelfUpdateCapability | null;
    readonly targetVersion: string;
    readonly channel?: DesktopUpdateChannel | undefined;
  },
  serverVersion: string | undefined,
): boolean {
  return (
    target.channel === undefined &&
    target.selfUpdate !== null &&
    serverVersion !== undefined &&
    crossesReleaseTrack(serverVersion, target.targetVersion)
  );
}

function CrossTrackNote() {
  return (
    <span className="text-muted-foreground text-xs">
      <T>Switch tracks in About → Update track</T>
    </span>
  );
}

function updateFailureMessage(error: unknown): string {
  return thrownErrorMessage(error, m) ?? m(msg("Server update failed."));
}

export interface ServerUpdateTarget {
  readonly environmentId: EnvironmentId;
  readonly serverLabel: string;
  readonly selfUpdate: ServerSelfUpdateCapability | null;
  readonly installation?: ServerInstallation | undefined;
  readonly desktopAppUpdate?: boolean;
  readonly threadContinuation?: boolean;
  readonly targetVersion: string;
  /** Set only by a track switch; the host's desktop app moves to this track. */
  readonly channel?: DesktopUpdateChannel;
  /** A track switch's checked release migration; the host re-checks its own database. */
  readonly targetDatabaseMigration?: number;
  /** The host already runs its track's newest build and only saves the track. */
  readonly trackOnly?: boolean;
}

type UpdateButtonProps = Pick<ComponentProps<typeof Button>, "variant" | "size" | "className"> & {
  readonly label?: string;
  readonly appearance?: "button" | "icon";
};

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
  const activity = serverUpdateActivity(hosts, true);
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
function useServerUpdates() {
  const updateServer = useAtomCommand(serverEnvironment.updateServer, { reportFailure: false });
  const readHostActivity = useReadHostActivity();
  const updateOne = async (
    target: ServerUpdateTarget,
    quiet: boolean,
    confirmed: boolean,
  ): Promise<ServerUpdateOutcome> => {
    const { environmentId, serverLabel, selfUpdate, targetVersion } = target;
    const denial = readUpdatesDenial(environmentId);
    if (denial !== undefined) {
      if (!quiet) {
        toastManager.add({
          type: "error",
          title: m(msg("{serverLabel} not updated", { serverLabel })),
          description: denial,
        });
      }
      return { status: "failed", message: denial };
    }
    if (!canUpdateServer(appAtomRegistry.get(environmentSession.sessionStateAtom(environmentId))))
      return { status: "skipped" };
    const result = await updateServer({
      environmentId,
      input: {
        targetVersion,
        confirmed,
        ...(continuesRunningThreads(target) ? { continueRunningThreads: true } : {}),
        ...(target.channel === undefined ? {} : { channel: target.channel }),
        ...(target.targetDatabaseMigration === undefined
          ? {}
          : { targetDatabaseMigration: target.targetDatabaseMigration }),
      },
    });
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return { status: "skipped" };
      const message = updateFailureMessage(squashAtomCommandFailure(result));
      if (!quiet) {
        toastManager.add({
          type: "error",
          title: m(msg("{serverLabel} update failed", { serverLabel })),
          description: message,
        });
      }
      return { status: "failed", message };
    }
    if (!quiet) {
      toastManager.add({
        type: "success",
        title: m(msg("{serverLabel} updated", { serverLabel })),
        description:
          selfUpdate === "desktop-managed"
            ? m(
                msg("Desktop app relaunched on {version}.", {
                  version: result.value.targetVersion,
                }),
              )
            : m(msg("Reconnected on styal@{version}.", { version: result.value.targetVersion })),
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
        const check = checkServerUpdateHosts(readHostActivity, claimed);
        const early = await settleWithinGrace(check);
        if (early !== null) {
          const { confirmation } = early.value;
          // Without a dialog host (undefined), only a safe check can proceed.
          if (
            confirmation !== null &&
            !(await requestConfirmDialog(confirmation.message, {
              confirmLabel: m(msg("Update")),
              threadActivity: confirmation.threadActivity,
            }))
          ) {
            return skipAll(targets);
          }
          explicitConsent = confirmation !== null;
        } else {
          const hosts = claimed.map(serverUpdateHost);
          let showResult: ((message: string, options?: ConfirmDialogOptions) => void) | undefined;
          const answer = requestConfirmDialog(
            serverUpdateCheckingMessage(hosts),
            { confirmLabel: m(msg("Update anyway")) },
            { checking: true, bindContentUpdate: (update) => (showResult = update) },
          );
          if (answer === undefined) {
            if ((await check).confirmation !== null) return skipAll(targets);
          } else {
            void check.then(({ confirmation }) =>
              showResult?.(
                confirmation?.message ?? serverUpdateSafeMessage(hosts),
                confirmation === null
                  ? { confirmLabel: m(msg("Update")) }
                  : { confirmLabel: m(msg("Update")), threadActivity: confirmation.threadActivity },
              ),
            );
            if (!(await answer)) return skipAll(targets);
            explicitConsent = true;
          }
        }
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

export function useServerUpdate() {
  const update = useServerUpdates();
  return async (
    target: ServerUpdateTarget,
    options?: { readonly quiet?: boolean; readonly confirmed?: boolean },
  ): Promise<ServerUpdateOutcome> =>
    (await update([target], options))[0]?.outcome ?? { status: "skipped" };
}

export function ServerUpdatesAction({
  targets,
  label,
  variant = "outline",
  size = "xs",
  className,
}: UpdateButtonProps & {
  readonly targets: ReadonlyArray<ServerUpdateTarget>;
}) {
  const gt = useGT();
  const messages = useMessages();
  const update = useServerUpdates();
  const serverConfigs = useServerConfigs();
  const pending = useRef(false);
  const [isPending, setIsPending] = useState(false);
  const eligible = targets.filter(
    (target) =>
      target.selfUpdate !== null &&
      (target.selfUpdate !== "desktop-managed" || target.desktopAppUpdate) &&
      managedUpdatesDenial(serverConfigs.get(target.environmentId)?.managedPolicy, messages) ===
        undefined &&
      !refusedCrossing(target, serverConfigs.get(target.environmentId)?.environment.serverVersion),
  );
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
      {label ?? gt("Update all")}
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
}: {
  readonly state: Exclude<ServerUpdateState, { status: "idle" }>;
}) {
  const messages = useMessages();
  if (state.status === "failed") {
    return (
      <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-destructive" role="alert">
        <span className="size-1.5 shrink-0 rounded-full bg-destructive" aria-hidden="true" />
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="min-w-0 truncate">{serverUpdateFailureText(state, messages)}</span>
            }
          />
          <TooltipPopup side="top">{serverUpdateFailureText(state, messages)}</TooltipPopup>
        </Tooltip>
      </div>
    );
  }
  return (
    <div className="mt-1 flex items-center gap-2 text-xs font-medium text-foreground">
      <span className="size-1.5 shrink-0 rounded-full bg-foreground" aria-hidden="true" />
      <span>{serverUpdateStageLabel(state.stage, messages)}</span>
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
  targetVersion,
  channel,
  label,
  variant = "outline",
  size = "xs",
  className,
  appearance = "button",
}: ServerUpdateTarget & UpdateButtonProps) {
  const gt = useGT();
  const messages = useMessages();
  const serverVersion = useServerConfigs().get(environmentId)?.environment.serverVersion;
  const sessionStateAtom = environmentSession.sessionStateAtom(environmentId);
  const canUpdate = useAtomValue(sessionStateAtom, canUpdateServer);
  const updatesDenial = managedUpdatesDenial(useManagedPolicy(environmentId), messages);
  const update = useServerUpdate();
  const updatesInstall =
    installation?.kind === "npm-global" || installation?.kind === "t3-launcher";
  const { copyToClipboard } = useCopyToClipboard<{ command: string }>({
    target: updatesInstall
      ? {
          target: "update command",
          unavailableMessage: msg("Clipboard API is unavailable while copying update command."),
          failureMessage: msg("Failed to copy update command to the clipboard."),
        }
      : {
          target: "relaunch command",
          unavailableMessage: msg("Clipboard API is unavailable while copying relaunch command."),
          failureMessage: msg("Failed to copy relaunch command to the clipboard."),
        },
    onCopy: ({ command }) => {
      toastManager.add({
        type: "success",
        title: updatesInstall ? gt("Update command copied") : gt("Relaunch command copied"),
        description: updatesInstall
          ? gt("Run `{command}` on {serverLabel}, then restart t3 with your usual options.", {
              command,
              serverLabel,
            })
          : gt(
              "Stop t3 on {serverLabel}, then relaunch with `{command}` using the same subcommand and options. This does not update an installed t3 command.",
              { command, serverLabel },
            ),
      });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: gt("Could not copy update command"),
        description: error.message,
      });
    },
  });

  const handleUpdate = async () => {
    if (
      !canUpdateServer(appAtomRegistry.get(sessionStateAtom)) ||
      pendingUpdateEnvironmentIds.has(environmentId)
    ) {
      return;
    }
    if (!canUpdateServer(appAtomRegistry.get(sessionStateAtom))) return;
    await update({
      environmentId,
      serverLabel,
      selfUpdate,
      desktopAppUpdate,
      targetVersion,
    });
  };

  if (updatesDenial !== undefined) {
    return appearance === "icon" ? (
      <ManagedControl reason={updatesDenial}>
        <Button size="icon-xs" variant="ghost-muted" aria-label={updatesDenial} disabled>
          <CircleArrowUpIcon className="size-3.5" />
        </Button>
      </ManagedControl>
    ) : (
      <span className="text-muted-foreground text-xs">{updatesDenial}</span>
    );
  }

  if (selfUpdate === "desktop-managed" && !desktopAppUpdate) {
    return (
      <span className="text-muted-foreground text-xs">
        <T>Update the desktop app on that machine to update this server.</T>
      </span>
    );
  }

  if (refusedCrossing({ selfUpdate, targetVersion, channel }, serverVersion)) {
    return <CrossTrackNote />;
  }

  const manualCommand =
    selfUpdate === null ? manualServerUpdateCommand(targetVersion, installation) : null;
  const actionLabel =
    manualCommand !== null
      ? updatesInstall
        ? gt("Copy update command")
        : gt("Copy relaunch command")
      : (label ?? gt("Update", { $context: "verb, updates the server" }));
  const onClick =
    manualCommand !== null
      ? () => copyToClipboard(manualCommand, { command: manualCommand })
      : () => void handleUpdate();

  if (appearance === "icon") {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost-muted"
              className={className}
              aria-label={gt("{action} for {serverLabel}", { action: actionLabel, serverLabel })}
              disabled={manualCommand === null && !canUpdate}
              onClick={onClick}
            />
          }
        >
          <CircleArrowUpIcon className="size-3.5" />
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
      disabled={manualCommand === null && !canUpdate}
      onClick={onClick}
    >
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
  label,
}: {
  readonly environmentId: EnvironmentId;
  readonly serverLabel: string;
  readonly fromVersion: string | undefined;
  readonly targetVersion: string;
  readonly label?: string;
}) {
  const gt = useGT();
  const update = useAtomCommand(updateOutdatedServer, { reportFailure: false });
  const handleUpdate = async () => {
    if (pendingUpdateEnvironmentIds.has(environmentId)) return;
    const confirmed = await requestConfirmDialog(
      m(
        msg("Update the {serverLabel}? Running threads and terminals may be interrupted.", {
          serverLabel,
        }),
      ),
      { confirmLabel: m(msg("Update", { $context: "verb, updates the server" })) },
    );
    if (confirmed !== true) return;
    pendingUpdateEnvironmentIds.add(environmentId);
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
        title: m(msg("{serverLabel} update failed", { serverLabel })),
        description: updateFailureMessage(squashAtomCommandFailure(result)),
      });
      return;
    }
    toastManager.add({
      type: "success",
      title: m(msg("{serverLabel} updated", { serverLabel })),
      description: m(
        msg("Reconnected on styal@{version}.", { version: result.value.targetVersion }),
      ),
    });
  };
  if (fromVersion !== undefined && crossesReleaseTrack(fromVersion, targetVersion)) {
    return <CrossTrackNote />;
  }
  return (
    <Button size="xs" variant="outline" onClick={() => void handleUpdate()}>
      {label ?? gt("Update", { $context: "verb, updates the server" })}
    </Button>
  );
}
