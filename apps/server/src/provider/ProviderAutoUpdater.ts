/**
 * ProviderAutoUpdater — installs provider CLI updates in the background when
 * `autoUpdateProviders` is on.
 *
 * It installs only a version the provider canary verified for this styal
 * release (`autoUpdates` in the manifest's compatibility policy), read from a
 * copy of the manifest fetched from `main` in the last two days. Only
 * installers that can pin an exact version take part; native self-updaters
 * and Homebrew cannot be held to the verified version.
 *
 * A CLI is skipped while a thread whose provider instance runs it is
 * preparing, starting, running or waiting on the user; threads on other CLIs
 * never hold it back. The runner checks again under the machine-wide install
 * lock, where new turns on that CLI wait for the install, so a CLI is not
 * replaced under a turn. Dev servers never run it: they share the host's
 * provider CLIs with the developer's real install.
 */
import type {
  OrchestrationV2ThreadShell,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Clock from "effect/Clock";
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

/** The version to install on `provider`, or null to leave it alone. */
export function decideProviderAutoUpdate(
  provider: ServerProvider,
  testedVersion: string | null,
): string | null {
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
  return compareSemverVersions(current, testedVersion) < 0 ? testedVersion : null;
}

/** A thread whose provider process would have its CLI replaced under it. */
function isThreadUsingProvider(
  thread: Pick<OrchestrationV2ThreadShell, "status" | "pendingRuntimeRequest">,
): boolean {
  return (
    thread.pendingRuntimeRequest !== null ||
    thread.status === "preparing" ||
    thread.status === "starting" ||
    thread.status === "running" ||
    thread.status === "waiting"
  );
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
  const busyReason = (target: ProviderInstallTarget) =>
    projections.getShellSnapshot({ location: "active" }).pipe(
      NodeSqliteClient.readOnly,
      Effect.flatMap(({ threads }) =>
        Effect.forEach(
          new Set(threads.filter(isThreadUsingProvider).map((thread) => thread.providerInstanceId)),
          installGate.targetFor,
        ),
      ),
      Effect.map((targets) =>
        targets.some(
          (candidate) =>
            candidate !== null &&
            candidate.lockKey === target.lockKey &&
            candidate.packageName === target.packageName,
        )
          ? "a thread using this provider CLI is running or waiting"
          : null,
      ),
      // Unknown activity counts as busy; the next pass tries again.
      Effect.catchCause(() => Effect.succeed("thread activity could not be read")),
    );

  const testedVersionFor = Effect.fn("ProviderAutoUpdater.testedVersionFor")(function* (
    provider: ServerProvider,
  ) {
    const remote = yield* manifestService.remote;
    const now = yield* Clock.currentTimeMillis;
    const capabilities = yield* providerRegistry.getProviderMaintenanceCapabilitiesForInstance(
      provider.instanceId,
      provider.driver,
    );
    return resolveRecentProviderAutoUpdateVersion(
      remote,
      now,
      provider.driver,
      capabilities.packageName,
    );
  });

  // Runs under the machine-wide install lock, with new turns on this CLI held.
  // A fresh health check sees a manual update or another server's install
  // that finished while this one waited, or another instance that shares the
  // same CLI and was already updated.
  const shouldStart = (
    provider: ServerProvider,
    targetVersion: string,
    target: ProviderInstallTarget,
  ) =>
    Effect.gen(function* () {
      const skip = (reason: string) =>
        Effect.logInfo("Background provider update skipped", {
          instanceId: provider.instanceId,
          reason,
        }).pipe(Effect.as(false));
      const providers = yield* providerRegistry.refreshInstance(provider.instanceId);
      const current = providers.find((candidate) => candidate.instanceId === provider.instanceId);
      const version = stableProviderVersion(provider.driver, current?.version);
      if (
        !current?.enabled ||
        !current.installed ||
        current.status === "error" ||
        version === null ||
        compareSemverVersions(version, targetVersion) >= 0
      )
        return yield* skip("the provider is already updated or no longer healthy");
      if ((yield* testedVersionFor(current)) !== targetVersion)
        return yield* skip("the verified version changed");
      // Last, so a turn started during the checks above is still seen.
      if (!(yield* isEnabled)) return yield* skip("automatic updates were turned off");
      const busy = yield* busyReason(target);
      if (busy !== null) {
        yield* countBusySkip(provider.instanceId);
        return yield* skip(busy);
      }
      return true;
    }).pipe(
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
      const targetVersion = decideProviderAutoUpdate(provider, yield* testedVersionFor(provider));
      if (targetVersion === null) continue;
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
      });
      // The runner publishes the update state, so clients show a background
      // update the same way as one they started.
      yield* runner
        .updateProvider({
          provider: provider.driver,
          instanceId: provider.instanceId,
          targetVersion,
          autoUpdate: { shouldStart: shouldStart(provider, targetVersion, target) },
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
