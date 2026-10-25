/**
 * Both events send structural fields only: never instance names or IDs a user chose, paths,
 * commands, installer output or error messages.
 */
import {
  defaultInstanceIdForDriver,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUpdateState,
} from "@t3tools/contracts";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

import { stableProviderVersion } from "../provider/providerCompatibility.ts";
import {
  makeTargetedProviderUpdateAction,
  type ProviderMaintenanceCapabilities,
} from "@t3tools/provider-core/server/maintenanceResolver";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AnalyticsService from "./AnalyticsService.ts";

/** Who owns the provider executable, as the maintenance code detected it. */
export type ProviderInstallerKind =
  | "npm"
  | "bun"
  | "pnpm"
  | "yarn"
  | "volta"
  | "vite-plus"
  | "homebrew"
  | "native"
  // No update action: missing, unrecognized, or a manual-only install.
  | "unknown";

const INSTALLER_BY_LOCK_KEY: Readonly<Record<string, ProviderInstallerKind>> = {
  "bun-global": "bun",
  "pnpm-global": "pnpm",
  "yarn-global": "yarn",
  volta: "volta",
  "vite-plus-global": "vite-plus",
  homebrew: "homebrew",
};

export function providerInstallerKind(
  capabilities: Pick<ProviderMaintenanceCapabilities, "update">,
): ProviderInstallerKind {
  const lockKey = capabilities.update?.lockKey;
  if (lockKey === undefined) return "unknown";
  if (lockKey.startsWith("npm-global:")) return "npm";
  // Every other update action is the provider's own updater.
  return INSTALLER_BY_LOCK_KEY[lockKey] ?? "native";
}

function providerInventoryProperties(input: {
  readonly provider: ServerProvider;
  readonly capabilities: ProviderMaintenanceCapabilities;
  readonly autoUpdatesEnabled: boolean;
  readonly busySkips: number;
}) {
  const { provider } = input;
  const version = stableProviderVersion(provider.driver, provider.version);
  const verifiedVersion = provider.compatibilityAdvisory?.verifiedVersion ?? null;
  return {
    driver: provider.driver,
    instance:
      provider.instanceId === defaultInstanceIdForDriver(provider.driver) ? "default" : "custom",
    installed: provider.installed,
    enabled: provider.enabled,
    status: provider.status,
    version,
    installerKind: providerInstallerKind(input.capabilities),
    // Background updates install an exact verified version, so only installers that can pin one take part.
    canAutoUpdate: makeTargetedProviderUpdateAction(input.capabilities, "0.0.0") !== null,
    autoUpdatesEnabled: input.autoUpdatesEnabled,
    // The newest version tested for this install whenever one is known, so a
    // provider its own updater moved ahead of it is visible too.
    testedVersion: verifiedVersion,
    autoUpdateTargetVersion:
      verifiedVersion !== null &&
      version !== null &&
      compareSemverVersions(version, verifiedVersion) < 0
        ? verifiedVersion
        : null,
    autoUpdateBusySkips: input.busySkips,
    // Whether the provider's own updater still owns the install; null when unknown or undetectable.
    selfUpdaterActive: input.capabilities.selfUpdaterActive ?? null,
  };
}

// Matches the auto-updater's first pass: boot-time provider probes have settled by then.
const INVENTORY_FIRST_REPORT_DELAY = Duration.minutes(2);
const INVENTORY_INTERVAL = Duration.hours(24);

/**
 * Records one `provider.inventory` event per available provider instance.
 * `takeBusySkips` returns and resets the background updates skipped per
 * instance since the previous report.
 */
const reportProviderInventory = Effect.fn("ProviderAnalytics.reportProviderInventory")(
  function* (takeBusySkips: Effect.Effect<ReadonlyMap<ProviderInstanceId, number>>) {
    const analytics = yield* AnalyticsService.AnalyticsService;
    const registry = yield* ProviderRegistry;
    const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
    const providers = yield* registry.getProviders;
    const busySkips = yield* takeBusySkips;
    const autoUpdatesEnabled = settings.enableProviderUpdateChecks && settings.autoUpdateProviders;
    // An unavailable instance is configuration this build cannot run, not an installed provider.
    for (const provider of providers.filter((entry) => entry.availability !== "unavailable")) {
      const capabilities = yield* registry.getProviderMaintenanceCapabilitiesForInstance(
        provider.instanceId,
        provider.driver,
      );
      yield* analytics.record(
        "provider.inventory",
        providerInventoryProperties({
          provider,
          capabilities,
          autoUpdatesEnabled,
          busySkips: busySkips.get(provider.instanceId) ?? 0,
        }),
      );
    }
  },
  Effect.catchCause((cause) => Effect.logDebug("Provider inventory report failed", { cause })),
);

/** Reports the provider inventory after startup settles, then daily, without blocking startup. */
export const startProviderInventory = (
  takeBusySkips: Effect.Effect<ReadonlyMap<ProviderInstanceId, number>>,
) =>
  Effect.sleep(INVENTORY_FIRST_REPORT_DELAY).pipe(
    Effect.andThen(
      reportProviderInventory(takeBusySkips).pipe(
        Effect.repeat(Schedule.spaced(INVENTORY_INTERVAL)),
      ),
    ),
    Effect.forkScoped,
    Effect.asVoid,
  );

export type ProviderUpdateFailureReason =
  | "install_in_progress"
  | "installation_changed"
  | "version_rejected"
  | "timeout"
  | "permission_denied"
  | "command_failed"
  | "spawn_failed"
  | "not_installed_after_install"
  | "unchanged_after_install"
  | "provider_error_after_install"
  | "interrupted"
  | "internal_error";

/** Classifies a failed installer run from its result; the output itself is never sent. */
export function updateCommandFailureReason(result: {
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
}): ProviderUpdateFailureReason {
  if (result.timedOut) return "timeout";
  return /\b(?:EACCES|EPERM)\b|permission denied/i.test(`${result.stderr}\n${result.stdout}`)
    ? "permission_denied"
    : "command_failed";
}

export interface ProviderUpdateStart {
  readonly source: "background" | "manual";
  /** A background reinstall of the installed version that hands updates to styal. */
  readonly takeover: boolean;
  readonly provider: ServerProvider["driver"];
  readonly instanceId: ProviderInstanceId;
  readonly capabilities: Pick<ProviderMaintenanceCapabilities, "update">;
  readonly fromVersion: string | null | undefined;
  readonly targetVersion: string | undefined;
}

function providerUpdateFinishedProperties(
  input: ProviderUpdateStart & {
    readonly resultVersion: string | null | undefined;
    readonly status: ServerProviderUpdateState["status"];
    readonly failureReason: ProviderUpdateFailureReason | null;
    readonly durationMs: number;
  },
) {
  const outcome =
    input.status === "succeeded"
      ? "success"
      : input.status === "unchanged"
        ? "unchanged"
        : "failed";
  return {
    source: input.source,
    takeover: input.takeover,
    driver: input.provider,
    installerKind: providerInstallerKind(input.capabilities),
    fromVersion: stableProviderVersion(input.provider, input.fromVersion),
    // A pinned version comes from the client or the manifest; only a plain version is reported.
    targetVersion: stableProviderVersion(input.provider, input.targetVersion),
    resultVersion: stableProviderVersion(input.provider, input.resultVersion),
    outcome,
    failureReason: outcome === "success" ? null : (input.failureReason ?? "internal_error"),
    durationMs: Math.max(0, Math.round(input.durationMs)),
  };
}

export type ProviderUpdateRecorder = (
  status: ServerProviderUpdateState["status"],
  failureReason: ProviderUpdateFailureReason | null,
  providers: ReadonlyArray<ServerProvider>,
) => Effect.Effect<void>;

/**
 * Starts timing one update. The returned recorder sends `provider.update.finished`
 * for the first result it is given and ignores later ones; telemetry never
 * changes the update's result.
 */
export const startProviderUpdateRecording = (
  analytics: AnalyticsService.AnalyticsService["Service"],
  start: ProviderUpdateStart,
) =>
  Effect.map(Clock.currentTimeMillis, (startedAtMs): ProviderUpdateRecorder => {
    let recorded = false;
    return (status, failureReason, providers) =>
      Effect.gen(function* () {
        if (recorded) return;
        recorded = true;
        const durationMs = (yield* Clock.currentTimeMillis) - startedAtMs;
        yield* analytics.record(
          "provider.update.finished",
          providerUpdateFinishedProperties({
            ...start,
            resultVersion: providers.find((entry) => entry.instanceId === start.instanceId)
              ?.version,
            status,
            failureReason,
            durationMs,
          }),
        );
      }).pipe(Effect.ignoreCause);
  });
