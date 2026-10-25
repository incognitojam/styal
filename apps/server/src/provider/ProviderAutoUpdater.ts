/**
 * Installs only canary-verified versions through pinnable installers; a native install whose own
 * updater is on is reinstalled to turn it off. A CLI waits while its threads are busy, except a
 * question pending an hour after its run, and is rechecked under the install lock. Dev servers
 * never run it because they share the host's provider CLIs.
 */
import type {
  OrchestrationV2ThreadShell,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";

import { ServerConfig } from "../config.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ModelManifest from "./ModelManifest.ts";
import {
  resolveRecentProviderAutoUpdateVersion,
  stableProviderVersion,
} from "./providerCompatibility.ts";
import { ProviderInstallGate, type ProviderInstallTarget } from "./ProviderInstallGate.ts";
import { ProviderMaintenanceRunner } from "./providerMaintenanceRunner.ts";
import { ProviderRegistry } from "./ProviderRegistry.ts";

const FIRST_PASS_DELAY = Duration.minutes(2);
const PASS_INTERVAL = Duration.minutes(30);
/** One attempt per instance and version in this window, so a failing install is not retried every pass. */
const RETRY_AFTER_MS = 6 * 60 * 60 * 1_000;

export interface ProviderAutoUpdateDecision {
  readonly version: string;
  /**
   * Reinstalls the version already installed, so the provider's own updater
   * stops and styal takes over its updates.
   */
  readonly takeover: boolean;
}

/**
 * What to install on `provider`, or null to leave it alone. A provider behind
 * the tested version moves to it. One already on it whose own updater is
 * still active (`selfUpdaterActive`) gets it again as a pinned install, which
 * turns that updater off. Nothing is ever moved back.
 */
export function decideProviderAutoUpdate(
  provider: ServerProvider,
  testedVersion: string | null,
  selfUpdaterActive?: boolean | null,
): ProviderAutoUpdateDecision | null {
  // A provider that already fails its health check (often signed out) is left
  // alone: the update could not be verified and would be reported as failing.
  if (
    testedVersion === null ||
    !provider.enabled ||
    !provider.installed ||
    provider.status === "error"
  )
    return null;
  const current = stableProviderVersion(provider.driver, provider.version);
  const advisory = provider.versionAdvisory;
  if (current === null || !advisory?.canUpdate || !advisory.canInstallVersion) return null;
  const order = compareSemverVersions(current, testedVersion);
  if (order < 0) return { version: testedVersion, takeover: false };
  if (order === 0 && selfUpdaterActive === true) return { version: testedVersion, takeover: true };
  return null;
}

/**
 * How long a question may stay pending after its run finished before it stops
 * holding back an update. Some providers (Codex) keep working after asking, so
 * a run can complete while its question waits unseen for hours.
 */
const LEFTOVER_REQUEST_AFTER_MS = 60 * 60 * 1_000;

/**
 * How a thread's provider process would be affected by replacing its CLI:
 * "busy" while a run is active or a question is pending, "leftover" when only
 * a question older than `LEFTOVER_REQUEST_AFTER_MS` remains after its run
 * finished, or null when idle.
 */
function threadProviderUse(
  thread: Pick<
    OrchestrationV2ThreadShell,
    "status" | "activityRunStatus" | "pendingRuntimeRequest"
  >,
  now: number,
): "busy" | "leftover" | null {
  const runActive =
    (thread.activityRunStatus ?? null) !== null ||
    thread.status === "preparing" ||
    thread.status === "starting" ||
    thread.status === "running" ||
    thread.status === "waiting";
  if (runActive) return "busy";
  const request = thread.pendingRuntimeRequest;
  if (request === null) return null;
  return now - DateTime.toEpochMillis(request.createdAt) >= LEFTOVER_REQUEST_AFTER_MS
    ? "leftover"
    : "busy";
}

export interface ProviderAutoUpdater {
  /** One pass over every provider instance; exposed for tests. */
  readonly runPass: Effect.Effect<void>;
  /** Forks the periodic passes into the caller's scope. */
  readonly start: Effect.Effect<void, never, Scope.Scope>;
  /** Returns and resets, per instance, the updates skipped because a thread was using its CLI. */
  readonly takeBusySkips: Effect.Effect<ReadonlyMap<ProviderInstanceId, number>>;
}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const providerRegistry = yield* ProviderRegistry;
  const runner = yield* ProviderMaintenanceRunner;
  const manifestService = yield* ModelManifest.ModelManifest;
  const projections = yield* ProjectionStoreV2;
  const installGate = yield* ProviderInstallGate;
  const attemptedAt = new Map<string, number>();
  let busySkips = new Map<ProviderInstanceId, number>();
  const countBusySkip = (instanceId: ProviderInstanceId) =>
    Effect.sync(() => {
      busySkips.set(instanceId, (busySkips.get(instanceId) ?? 0) + 1);
    });

  const isEnabled = settingsService.getSettings.pipe(
    Effect.map((settings) => settings.enableProviderUpdateChecks && settings.autoUpdateProviders),
  );

  /**
   * Why `target` cannot be replaced now, or null when no thread uses it.
   * Archived threads have no provider session, so only active ones count.
   */
  const busyReason = Effect.fn("ProviderAutoUpdater.busyReason")(
    function* (target: ProviderInstallTarget) {
      const { threads } = yield* projections
        .getShellSnapshot({ location: "active", busyOnly: true })
        .pipe(NodeSqliteClient.readOnly);
      const now = yield* Clock.currentTimeMillis;
      const sharesCli = new Map<ProviderInstanceId, boolean>();
      const usesTarget = Effect.fnUntraced(function* (instanceId: ProviderInstanceId) {
        const known = sharesCli.get(instanceId);
        if (known !== undefined) return known;
        const candidate = yield* installGate.targetFor(instanceId);
        const shares =
          candidate !== null &&
          candidate.lockKey === target.lockKey &&
          candidate.packageName === target.packageName;
        sharesCli.set(instanceId, shares);
        return shares;
      });
      const leftovers: Array<(typeof threads)[number]> = [];
      for (const thread of threads) {
        const use = threadProviderUse(thread, now);
        if (use === null || !(yield* usesTarget(thread.providerInstanceId))) continue;
        if (use === "busy") return "a thread using this provider CLI is running or waiting";
        leftovers.push(thread);
      }
      // The question text stays out of the log.
      yield* Effect.forEach(leftovers, (thread) =>
        Effect.logInfo("Background provider update ignores a leftover question", {
          instanceId: thread.providerInstanceId,
          threadId: thread.id,
        }),
      );
      return null;
    },
    // Unknown activity counts as busy; the next pass tries again.
    Effect.catchCause(() => Effect.succeed("thread activity could not be read")),
  );

  const maintenanceFor = (provider: ServerProvider, options?: { readonly fresh?: boolean }) =>
    providerRegistry.getProviderMaintenanceCapabilitiesForInstance(
      provider.instanceId,
      provider.driver,
      options,
    );

  const testedVersionFor = Effect.fn("ProviderAutoUpdater.testedVersionFor")(function* (
    provider: ServerProvider,
    packageName: string | null,
  ) {
    const remote = yield* manifestService.remote;
    const now = yield* Clock.currentTimeMillis;
    return resolveRecentProviderAutoUpdateVersion(remote, now, provider.driver, packageName);
  });

  // Runs under the machine-wide install lock, with new turns on this CLI held.
  // A fresh health check sees a manual update or another server's install
  // that finished while this one waited, or another instance that shares the
  // same CLI and was already updated or taken over.
  const shouldStart = Effect.fn("ProviderAutoUpdater.shouldStart")(
    function* (
      provider: ServerProvider,
      decision: ProviderAutoUpdateDecision,
      target: ProviderInstallTarget,
    ) {
      const skip = (reason: string) =>
        Effect.logInfo("Background provider update skipped", {
          instanceId: provider.instanceId,
          reason,
        }).pipe(Effect.as(false));
      const providers = yield* providerRegistry.refreshInstance(provider.instanceId);
      const current = providers.find((candidate) => candidate.instanceId === provider.instanceId);
      const version = stableProviderVersion(provider.driver, current?.version);
      const order = version === null ? null : compareSemverVersions(version, decision.version);
      if (
        !current?.enabled ||
        !current.installed ||
        current.status === "error" ||
        order === null ||
        (decision.takeover ? order !== 0 : order >= 0)
      )
        return yield* skip("the provider is already updated or no longer healthy");
      const capabilities = yield* maintenanceFor(current, { fresh: decision.takeover });
      if (decision.takeover && capabilities.selfUpdaterActive !== true)
        return yield* skip("the provider's own updater is no longer active");
      if ((yield* testedVersionFor(current, capabilities.packageName)) !== decision.version)
        return yield* skip("the verified version changed");
      // Last, so a turn started during the checks above is still seen.
      if (!(yield* isEnabled)) return yield* skip("automatic updates were turned off");
      const busy = yield* busyReason(target);
      if (busy !== null) {
        yield* countBusySkip(provider.instanceId);
        return yield* skip(busy);
      }
      return true;
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Background provider update check failed", { cause }).pipe(
        Effect.as(false),
      ),
    ),
  );

  const runPass = Effect.gen(function* () {
    if (!(yield* isEnabled)) return;
    yield* manifestService.refresh;
    const providers = yield* providerRegistry.getProviders;
    for (const provider of providers) {
      const capabilities = yield* maintenanceFor(provider);
      const decision = decideProviderAutoUpdate(
        provider,
        yield* testedVersionFor(provider, capabilities.packageName),
        capabilities.selfUpdaterActive,
      );
      if (decision === null) continue;
      const { version: targetVersion, takeover } = decision;
      // A takeover counts as an attempt at its version like any update.
      const attemptKey = `${provider.instanceId}@${targetVersion}`;
      const now = yield* Clock.currentTimeMillis;
      const previous = attemptedAt.get(attemptKey);
      if (previous !== undefined && now >= previous && now - previous < RETRY_AFTER_MS) continue;
      const target = yield* installGate.targetFor(provider.instanceId);
      if (target === null) continue;
      const busy = yield* busyReason(target);
      if (busy !== null) {
        yield* countBusySkip(provider.instanceId);
        yield* Effect.logInfo("Background provider update skipped", {
          instanceId: provider.instanceId,
          toVersion: targetVersion,
          reason: busy,
        });
        continue;
      }
      yield* Effect.logInfo("Updating provider in the background", {
        instanceId: provider.instanceId,
        fromVersion: provider.version,
        toVersion: targetVersion,
        takeover,
      });
      // The runner publishes the update state, so clients show a background
      // update the same way as one they started.
      yield* runner
        .updateProvider({
          provider: provider.driver,
          instanceId: provider.instanceId,
          targetVersion,
          autoUpdate: { shouldStart: shouldStart(provider, decision, target), takeover },
        })
        .pipe(
          Effect.flatMap((result) => {
            const updated = result.providers.find(
              (candidate) => candidate.instanceId === provider.instanceId,
            );
            // Only an install that ran counts; one skipped by `shouldStart`
            // is tried again next pass.
            if (updated?.updateState) attemptedAt.set(attemptKey, now);
            return Effect.logInfo("Background provider update finished", {
              instanceId: provider.instanceId,
              status: updated?.updateState?.status ?? "skipped",
              message: updated?.updateState?.message ?? null,
            });
          }),
          Effect.catch((error) =>
            Effect.logWarning("Background provider update was not started", {
              instanceId: provider.instanceId,
              reason: error.reason,
            }),
          ),
        );
    }
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Background provider update failed", { cause })),
    Effect.withSpan("ProviderAutoUpdater.runPass"),
  );

  const start = Effect.gen(function* () {
    if (config.devUrl !== undefined) return;
    yield* Effect.sleep(FIRST_PASS_DELAY).pipe(
      Effect.andThen(runPass.pipe(Effect.repeat(Schedule.spaced(PASS_INTERVAL)))),
      Effect.forkScoped,
    );
  });

  const takeBusySkips = Effect.sync(() => {
    const taken = busySkips;
    busySkips = new Map();
    return taken;
  });

  return { runPass, start, takeBusySkips } satisfies ProviderAutoUpdater;
});
