import { useAtomValue } from "@effect/atom-react";
import { PROVIDER_DISPLAY_NAMES } from "@t3tools/contracts";
import { describeHostActivity } from "@t3tools/shared/hostActivity";

import { APP_VERSION } from "~/branding";
import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { isElectron } from "~/env";
import { useEnvironments } from "~/state/environments";
import { useNpmReleasePublished } from "~/state/npmRelease";
import { environmentIdsKey } from "~/state/environmentAtomList";
import { environmentUpdateStatesAtom } from "~/state/server";
import { environmentSessionStatesAtom } from "~/state/session";
import { getProviderUpdateRunOutcome } from "../ProviderUpdateLaunchNotification.logic";
import { useProviderUpdates } from "../ProviderUpdatesAction";
import {
  canUpdateServer,
  type ServerUpdateOutcome,
  useServerUpdateCheck,
  useServerUpdates,
} from "../ServerUpdateAction";
import {
  closeFinishedUpdateRun,
  collectRestartingMachines,
  collectServerUpdateTargets,
  collectUpdateEverythingResult,
  describeUpdateEverything,
  runUpdateEverything,
  serverUpdateKey,
  type SkippedMachine,
  type UpdateRunMachine,
  type UpdateEverythingConfirmation,
} from "./updateEverything.logic";
import {
  clearSavedUpdateEverythingResult,
  saveUpdateEverythingResult,
  setUpdateEverythingRun,
  settleUpdateRunMachine,
  showUpdateEverythingResult,
  waitForServerUpdateHandoff,
} from "./updateEverythingRun";

export type ReportLocalUpdateError = (title: string, description: string) => void;

/**
 * Skips providers that styal's managed updates install. This app relaunches once every server
 * restarts into its update; the summary toast waits for the relaunch, and servers still
 * restarting are followed after it.
 */
export function useUpdateEverything(localUpdateVersion: string | null) {
  const targetVersion = localUpdateVersion ?? APP_VERSION;
  const { environments } = useEnvironments();
  const environmentIds = environmentIdsKey(environments.map(({ environmentId }) => environmentId));
  const sessionStates = useAtomValue(environmentSessionStatesAtom(environmentIds));
  const updateStates = useAtomValue(environmentUpdateStatesAtom(environmentIds));
  const machines = environments.map((environment, index) => ({
    environmentId: environment.environmentId,
    label: environment.label,
    serverConfig: environment.serverConfig,
    connected: environment.connection.phase === "connected",
    hostedByThisApp:
      isElectron &&
      (environment.entry.target._tag === "PrimaryConnectionTarget" ||
        isDesktopLocalConnectionTarget(environment.entry.target)),
    canMaintain: canUpdateServer(sessionStates[index]!),
    updateState: updateStates[index]!,
  }));
  const { targets: behindServers, skipped: unreachable } = collectServerUpdateTargets(
    machines,
    targetVersion,
  );
  // Desktop-managed servers use their app feed; only npm installs need to wait for publication.
  const needsNpm = behindServers.some((server) => server.selfUpdate !== "desktop-managed");
  const published = useNpmReleasePublished(needsNpm ? targetVersion : null);
  const servers = published
    ? behindServers
    : behindServers.filter((server) => server.selfUpdate === "desktop-managed");
  const skipped: ReadonlyArray<SkippedMachine> = [
    ...unreachable,
    ...behindServers
      .filter((server) => !servers.includes(server))
      .map((server) => ({
        environmentId: server.environmentId,
        label: server.serverLabel,
        reason: `@styal/cli@${targetVersion} is not on npm yet`,
      })),
  ];
  // Settings still offers a manual update for providers styal manages.
  const providers = useProviderUpdates({ leaveManagedUpdates: true });
  // The fork checks each server for running work when the confirmation opens.
  // Without explicit consent, the server step checks again before restarting.
  const checkServers = useServerUpdateCheck();
  const updateServers = useServerUpdates();

  const { summary, lines } = describeUpdateEverything({
    localVersion: localUpdateVersion,
    servers,
    providerMachines: providers.machines.map((machine) => ({
      environmentId: machine.environmentId,
      label: machine.label,
      providers: machine.candidates.map(
        (candidate) => PROVIDER_DISPLAY_NAMES[candidate.driver] ?? candidate.driver,
      ),
    })),
  });

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
            "This app",
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
            checks.map((check) => check && { ...check, hostLabel: check.hostLabel ?? "This app" }),
            {
              uncheckedHostsLine: "Could not check this app for running work.",
              continueRunningThreads: true,
            },
          );
    return { ...activity, localVersion: localUpdateVersion };
  };

  const checkActivity = async (): Promise<UpdateEverythingConfirmation> => {
    const [remote, local] = await Promise.all([checkServers(servers), checkLocalActivity()]);
    return {
      lines: [...local.lines, ...remote.lines],
      threadActivity: [...local.threadActivity, ...remote.threadActivity],
      localVersion: local.localVersion,
      interrupts: local.interrupts || remote.interrupts,
      servers: serverUpdateKey(servers),
    };
  };

  return {
    hasUpdates: servers.length > 0 || providers.machines.length > 0,
    summary,
    lines,
    checkActivity,
    skipped,
    run: async ({
      downloadLocal,
      installLocal,
      confirmation,
    }: {
      downloadLocal?: (reportError: ReportLocalUpdateError) => Promise<boolean>;
      installLocal?: (reportError: ReportLocalUpdateError) => Promise<boolean>;
      /** What the user explicitly confirmed, which covers only the servers it checked. */
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
        localVersion,
        phase: "providers",
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
                  runOutcome.status === "failed" ? runOutcome.line : "Provider update interrupted",
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
          // Without explicit consent, check again after provider installations:
          // a resumable turn may have started waiting for input in the meantime.
          updateServers: async () => {
            type FinishedServer = { label: string; outcome: ServerUpdateOutcome };
            const settlers = new Map<
              UpdateRunMachine["environmentId"],
              {
                resolve: (finished: FinishedServer) => void;
                reject: (error: unknown) => void;
              }
            >();
            const runs = servers.map(
              (server) =>
                new Promise<FinishedServer>((resolve, reject) => {
                  settlers.set(server.environmentId, { resolve, reject });
                }),
            );
            updateServers(servers, {
              quiet: true,
              confirmed,
              onSettled: (server, serverOutcome) => {
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
                settlers.get(server.environmentId)?.resolve(finished);
              },
            }).catch((error: unknown) => {
              for (const settler of settlers.values()) settler.reject(error);
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
            skipped,
          });
        if (outcome.localReady && installLocal) {
          setUpdateEverythingRun((run) => run && { ...run, phase: "installing" });
          saveUpdateEverythingResult({ ...result(finishedServers), localVersion });
          if (await installLocal(reportLocalError)) return;
          clearSavedUpdateEverythingResult();
        }
        setUpdateEverythingRun(
          (run) =>
            run &&
            closeFinishedUpdateRun({
              ...run,
              phase: "servers",
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
