import { describeHostActivity } from "@t3tools/shared/hostActivityCopy";
import { useServerUpdateCheck } from "../ServerUpdateAction";
import { serverUpdateKey, type UpdateEverythingConfirmation } from "./updateEverything.logic";
import { msg, useMessages, useLocale } from "gt-react";
import { useAtomValue } from "@effect/atom-react";
import { connectionErrorText } from "@t3tools/client-runtime/connection";
import { PROVIDER_DISPLAY_NAMES } from "@t3tools/contracts";

import { APP_VERSION } from "~/branding";
import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { isElectron } from "~/env";
import { useEnvironments } from "~/state/environments";
import { environmentIdsKey } from "~/state/environmentAtomList";
import { environmentUpdateStatesAtom, serverEnvironment } from "~/state/server";
import { environmentSessionStatesAtom } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { getProviderUpdateRunOutcome } from "../ProviderUpdateLaunchNotification.logic";
import { useProviderUpdates } from "../ProviderUpdatesAction";
import { canUpdateServer, type ServerUpdateOutcome, useServerUpdate } from "../ServerUpdateAction";
import {
  type ChannelSwitchRelease,
  closeFinishedUpdateRun,
  collectChannelSwitchTargets,
  collectRestartingMachines,
  collectServerUpdateTargets,
  collectUpdateEverythingResult,
  describeUpdateEverything,
  runUpdateEverything,
  type UpdateRunMachine,
} from "./updateEverything.logic";
import {
  clearSavedUpdateEverythingResult,
  saveUpdateEverythingResult,
  setUpdateEverythingRun,
  settleUpdateRunMachine,
  showUpdateEverythingResult,
  waitForServerUpdateHandoff,
  waitForUpdateRestart,
} from "./updateEverythingRun";

const UPDATE_RESTART_DELAY_MS = 5_000;

/** Servers this desktop app runs; they update with it. */
export function isHostedByThisApp(
  environment: ReturnType<typeof useEnvironments>["environments"][number],
) {
  return (
    isElectron &&
    (environment.entry.target._tag === "PrimaryConnectionTarget" ||
      isDesktopLocalConnectionTarget(environment.entry.target))
  );
}

export type ReportLocalUpdateError = (title: string, description: string) => void;

/** `channelSwitch` makes the run move the fleet to that release's track instead of updating it. */
export function useUpdateEverything(
  localUpdateVersion: string | null,
  channelSwitch?: ChannelSwitchRelease,
) {
  const targetVersion = localUpdateVersion ?? APP_VERSION;
  const { environments } = useEnvironments();
  const resolve = useMessages();
  const locale = useLocale();
  const environmentIds = environmentIdsKey(environments.map(({ environmentId }) => environmentId));
  const sessionStates = useAtomValue(environmentSessionStatesAtom(environmentIds));
  const updateStates = useAtomValue(environmentUpdateStatesAtom(environmentIds));
  const machines = environments.map((environment, index) => ({
    environmentId: environment.environmentId,
    label: environment.label,
    serverConfig: environment.serverConfig,
    connected: environment.connection.phase === "connected",
    connectionError: connectionErrorText(environment.connection, resolve),
    turnedOff: !environment.entry.enabled,
    hostedByThisApp: isHostedByThisApp(environment),
    canMaintain: canUpdateServer(sessionStates[index]!),
    updateState: updateStates[index]!,
  }));
  const { targets: servers, skipped } = channelSwitch
    ? collectChannelSwitchTargets(machines, channelSwitch, resolve)
    : collectServerUpdateTargets(machines, targetVersion, resolve);
  // Track-only hosts save a setting and restart nothing, so they are neither listed nor counted.
  const moving = servers.filter((server) => server.trackOnly !== true);
  const restarts = collectRestartingMachines(machines, moving, localUpdateVersion !== null);
  const providerUpdates = useProviderUpdates();
  // A track switch moves app and servers only; provider updates stay a separate choice.
  const providers = channelSwitch ? { machines: [], updateAll: async () => [] } : providerUpdates;
  const updateServer = useServerUpdate();
  const checkServers = useServerUpdateCheck();
  const stageServerUpdate = useAtomCommand(serverEnvironment.stageServerUpdate, {
    reportFailure: false,
  });

  const view = describeUpdateEverything(
    {
      localVersion: localUpdateVersion,
      localMachines: machines.filter((machine) => machine.hostedByThisApp),
      servers: moving,
      skipped,
      providerMachines: providers.machines.map((machine) => ({
        environmentId: machine.environmentId,
        label: machine.label,
        providers: machine.candidates.map(
          (candidate) => PROVIDER_DISPLAY_NAMES[candidate.driver] ?? candidate.driver,
        ),
      })),
    },
    resolve,
  );

  const checkLocalActivity = async (): Promise<Omit<UpdateEverythingConfirmation, "servers">> => {
    if (localUpdateVersion === null) {
      return { lines: [], threadActivity: [], localVersion: null, interrupts: false };
    }
    const inspect = window.desktopBridge?.getLocalHostActivity;
    if (!inspect) {
      // An older desktop bridge cannot inspect itself or pin the confirmed version,
      // so ask the servers it hosts and let its installer check again.
      const hosted = await checkServers(
        collectRestartingMachines(machines, [], true).map((machine) => ({
          environmentId: machine.environmentId,
          serverLabel:
            machines.find((item) => item.environmentId === machine.environmentId)?.label ??
            resolve(msg("This app")),
          selfUpdate: null,
          targetVersion,
          threadContinuation: machine.continuesThreads,
        })),
      );
      return { ...hosted, localVersion: null };
    }
    const checks = await inspect().catch(() => [null]);
    const activity =
      checks.length === 0
        ? { lines: [], threadActivity: [], interrupts: false }
        : describeHostActivity(
            checks.map(
              (check) =>
                check && { ...check, hostLabel: check.hostLabel ?? resolve(msg("This app")) },
            ),
            {
              uncheckedHostsLine: resolve(msg("Could not check this app for running work.")),
              continueRunningThreads: true,
            },
            resolve,
          );
    return { ...activity, localVersion: localUpdateVersion };
  };

  const checkActivity = async (): Promise<UpdateEverythingConfirmation> => {
    const [remote, local] = await Promise.all([
      checkServers(servers.filter((server) => server.trackOnly !== true)),
      checkLocalActivity(),
    ]);
    return {
      lines: [...local.lines, ...remote.lines],
      threadActivity: [...local.threadActivity, ...remote.threadActivity],
      localVersion: local.localVersion,
      interrupts: local.interrupts || remote.interrupts,
      servers: serverUpdateKey(servers),
    };
  };

  // Shown when the check outlasts its grace period; confirming it is explicit consent.
  const checkingActivity = (): UpdateEverythingConfirmation => {
    const checked = [
      ...(localUpdateVersion === null ? [] : [resolve(msg("this app"))]),
      ...servers.filter((server) => server.trackOnly !== true).map((server) => server.serverLabel),
    ];
    return {
      lines: [
        resolve(
          msg("Still checking {servers} for running work.", {
            servers: new Intl.ListFormat(locale).format(checked),
          }),
        ),
        resolve(msg("Updating now may interrupt running threads and terminals.")),
      ],
      threadActivity: [],
      localVersion: window.desktopBridge?.getLocalHostActivity ? localUpdateVersion : null,
      interrupts: true,
      servers: serverUpdateKey(servers),
    };
  };

  return {
    hasUpdates: servers.length > 0 || providers.machines.length > 0,
    machines,
    ...view,
    restarts,
    checkActivity,
    checkingActivity,
    run: async ({
      downloadLocal,
      installLocal,
      confirmation,
    }: {
      downloadLocal?: (reportError: ReportLocalUpdateError) => Promise<boolean>;
      installLocal?: (reportError: ReportLocalUpdateError, confirmed?: boolean) => Promise<boolean>;
      confirmation?: UpdateEverythingConfirmation;
    }) => {
      const confirmed = confirmation?.servers === serverUpdateKey(servers);
      const localFailures: Array<string> = [];
      const reportLocalError: ReportLocalUpdateError = (title, description) => {
        localFailures.push(`${title}: ${description}`);
      };
      const startedAt = Date.now();
      const machinesById = new Map<UpdateRunMachine["environmentId"], UpdateRunMachine>();
      for (const machine of providers.machines) {
        machinesById.set(machine.environmentId, {
          environmentId: machine.environmentId,
          label: machine.label,
          updatesProviders: true,
          server: null,
          handedOffVersion: null,
          startedAt,
          result: null,
          failure: null,
          providerFailure: null,
        });
      }
      for (const server of servers) {
        const existing = machinesById.get(server.environmentId);
        machinesById.set(server.environmentId, {
          environmentId: server.environmentId,
          label: server.serverLabel,
          updatesProviders: existing?.updatesProviders ?? false,
          server,
          handedOffVersion: null,
          startedAt,
          result: null,
          failure: null,
          providerFailure: null,
        });
      }
      const localVersion = installLocal ? localUpdateVersion : null;
      setUpdateEverythingRun(() => ({
        ...(channelSwitch ? { trackSwitch: true } : {}),
        localVersion,
        phase: "providers",
        restartAt: null,
        machines: Array.from(machinesById.values()),
      }));
      const providerFailures = new Map<UpdateRunMachine["environmentId"], string>();
      const finishedServers: Array<{ label: string; outcome: ServerUpdateOutcome }> = [];
      try {
        const outcome = await runUpdateEverything({
          ...(downloadLocal ? { downloadLocal: () => downloadLocal(reportLocalError) } : {}),
          updateProviders: async () => {
            const runs = await providers.updateAll({ quiet: true });
            const outcomes = runs.map((run) => {
              const runOutcome = getProviderUpdateRunOutcome(run);
              if (runOutcome.status !== "updated") {
                providerFailures.set(
                  run.environmentId,
                  runOutcome.status === "failed"
                    ? runOutcome.line
                    : resolve(msg("Provider update interrupted")),
                );
              }
              return runOutcome;
            });
            for (const machine of machinesById.values()) {
              if (machine.server === null) {
                settleUpdateRunMachine(
                  machine.environmentId,
                  providerFailures.get(machine.environmentId) ?? null,
                );
              }
            }
            const serversStartedAt = Date.now();
            setUpdateEverythingRun(
              (run) =>
                run && {
                  ...run,
                  phase: "servers",
                  machines: run.machines.map((machine) =>
                    machine.server === null ? machine : { ...machine, startedAt: serversStartedAt },
                  ),
                },
            );
            return outcomes;
          },
          ...(providers.machines.length > 0
            ? {
                stageServers: () =>
                  new Map(
                    servers
                      .filter(
                        (server) =>
                          machines.find((machine) => machine.environmentId === server.environmentId)
                            ?.serverConfig?.environment.capabilities.serverUpdateStaging === true,
                      )
                      .map((server) => [
                        server.environmentId,
                        stageServerUpdate({
                          environmentId: server.environmentId,
                          input: { targetVersion: server.targetVersion, stageOnly: true },
                        }),
                      ]),
                  ),
              }
            : {}),
          updateServers: async (staged) => {
            const runs = servers.map(async (server) => {
              await staged.get(server.environmentId);
              const serverOutcome = await updateServer(server, { quiet: true, confirmed });
              settleUpdateRunMachine(
                server.environmentId,
                serverOutcome.status === "failed"
                  ? serverOutcome.message
                  : (providerFailures.get(server.environmentId) ?? null),
                {
                  serverUpdated: serverOutcome.status !== "failed",
                  providerFailure: providerFailures.get(server.environmentId) ?? null,
                },
              );
              const finished = { label: server.serverLabel, outcome: serverOutcome };
              finishedServers.push(finished);
              return finished;
            });
            await Promise.all(
              servers.map((server, index) =>
                waitForServerUpdateHandoff(server.environmentId, runs[index]!),
              ),
            );
            return runs;
          },
        });
        const result = (finished: ReadonlyArray<{ label: string; outcome: ServerUpdateOutcome }>) =>
          collectUpdateEverythingResult({
            localVersion: null,
            localFailures,
            servers: finished,
            providers: outcome.providers,
          });
        if (outcome.localReady && installLocal) {
          if (await waitForUpdateRestart(UPDATE_RESTART_DELAY_MS)) {
            setUpdateEverythingRun(
              (run) => run && { ...run, phase: "installing", restartAt: null },
            );
            saveUpdateEverythingResult({ ...result(finishedServers), localVersion });
            if (
              await installLocal(
                reportLocalError,
                confirmation?.localVersion === localUpdateVersion,
              )
            )
              return;
            clearSavedUpdateEverythingResult();
          }
        }
        setUpdateEverythingRun(
          (run) =>
            run &&
            closeFinishedUpdateRun({
              ...run,
              phase: "servers",
              restartAt: null,
              localVersion: null,
            }),
        );
        showUpdateEverythingResult(result(await Promise.all(outcome.servers)));
      } catch (error) {
        setUpdateEverythingRun(() => null);
        throw error;
      }
    },
  };
}
