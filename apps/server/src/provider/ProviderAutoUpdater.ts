/**
 * ProviderAutoUpdater — installs provider CLI updates in the background when
 * `autoUpdateProviders` is on.
 *
 * It never installs past the version the provider canary verified for this
 * styal release (`autoUpdateVersion` in the manifest's compatibility policy),
 * so a provider release reaches users only after a real turn has passed
 * against it. Installers that can pin a version install exactly that version;
 * the rest (native self-updaters, Homebrew) run only while their latest
 * version is the verified one.
 *
 * Passes skip while any thread is running or waiting, so a CLI is not
 * replaced under an active turn. Dev servers never run it: they share the
 * host's provider CLIs with the developer's real install.
 */
import type { ServerProvider } from "@t3tools/contracts";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";

import { ServerConfig } from "../config.ts";
import { summarizeHostSessions } from "../environment/HostActivity.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ModelManifest from "./ModelManifest.ts";
import {
  resolveProviderAutoUpdateVersion,
  stableProviderVersion,
} from "./providerCompatibility.ts";
import { ProviderMaintenanceRunner } from "./providerMaintenanceRunner.ts";
import { ProviderRegistry } from "./Services/ProviderRegistry.ts";

const FIRST_PASS_DELAY = Duration.minutes(2);
const PASS_INTERVAL = Duration.minutes(30);
/** One attempt per instance and version in this window, so a failing install is not retried every pass. */
const RETRY_AFTER_MS = 6 * 60 * 60 * 1_000;

export interface ProviderAutoUpdateDecision {
  /** Pinned version to install, or undefined to run the installer's own update. */
  readonly targetVersion: string | undefined;
}

/** Whether `provider` should be updated to `testedVersion`, and how. */
export function decideProviderAutoUpdate(
  provider: ServerProvider,
  testedVersion: string | null,
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
  if (current === null || !advisory?.canUpdate) return null;
  if (compareSemverVersions(current, testedVersion) >= 0) return null;
  if (advisory.canInstallVersion) return { targetVersion: testedVersion };
  return stableProviderVersion(provider.driver, advisory.latestVersion) === testedVersion
    ? { targetVersion: undefined }
    : null;
}

export interface ProviderAutoUpdater {
  /** One pass over every provider instance; exposed for tests. */
  readonly runPass: Effect.Effect<void>;
  /** Forks the periodic passes into the caller's scope. */
  readonly start: Effect.Effect<void, never, Scope.Scope>;
}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const providerRegistry = yield* ProviderRegistry;
  const runner = yield* ProviderMaintenanceRunner;
  const manifestService = yield* ModelManifest.ModelManifest;
  const projections = yield* ProjectionStoreV2;
  const attemptedAt = new Map<string, number>();

  const isHostBusy = projections.getShellSnapshot().pipe(
    Effect.map(({ threads }) => {
      const activity = summarizeHostSessions(threads);
      return activity.activeSessions + activity.waitingSessions > 0;
    }),
    // Unknown activity counts as busy; the next pass tries again.
    Effect.catchCause(() => Effect.succeed(true)),
  );

  const runPass = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings;
    if (!settings.enableProviderUpdateChecks || !settings.autoUpdateProviders) return;
    const manifest = yield* manifestService.refresh;
    const providers = yield* providerRegistry.getProviders;
    for (const provider of providers) {
      const testedVersion = resolveProviderAutoUpdateVersion(
        manifest.compatibility,
        ModelManifest.BUNDLED_MODEL_MANIFEST.compatibility,
        provider.driver,
      );
      const decision = decideProviderAutoUpdate(provider, testedVersion);
      if (decision === null) continue;
      const attemptKey = `${provider.instanceId}@${testedVersion}`;
      const now = yield* Clock.currentTimeMillis;
      const previous = attemptedAt.get(attemptKey);
      if (previous !== undefined && now >= previous && now - previous < RETRY_AFTER_MS) continue;
      if (yield* isHostBusy) return;
      attemptedAt.set(attemptKey, now);
      yield* Effect.logInfo("Updating provider in the background", {
        instanceId: provider.instanceId,
        fromVersion: provider.version,
        toVersion: testedVersion,
      });
      // The runner publishes the update state, so clients show a background
      // update the same way as one they started.
      yield* runner
        .updateProvider({
          provider: provider.driver,
          instanceId: provider.instanceId,
          targetVersion: decision.targetVersion,
          autoUpdate: true,
        })
        .pipe(
          Effect.flatMap((result) => {
            const updated = result.providers.find(
              (candidate) => candidate.instanceId === provider.instanceId,
            );
            return Effect.logInfo("Background provider update finished", {
              instanceId: provider.instanceId,
              status: updated?.updateState?.status ?? "unknown",
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

  return { runPass, start } satisfies ProviderAutoUpdater;
});
