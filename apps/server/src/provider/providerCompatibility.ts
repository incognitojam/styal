import {
  TrimmedNonEmptyString,
  ServerProviderCompatibilityStatus,
  type ProviderDriverKind,
  type ServerProvider,
  type ServerProviderCompatibilityAdvisory,
} from "@t3tools/contracts";
import { compareSemverVersions, satisfiesSemverRange } from "@t3tools/shared/semver";
import * as Schema from "effect/Schema";
import packageJson from "../../package.json" with { type: "json" };

const StableVersion = TrimmedNonEmptyString.pipe(
  Schema.check(Schema.makeFilter((value) => /^\d+\.\d+\.\d+$/.test(value))),
);
const VersionRange = TrimmedNonEmptyString.pipe(
  Schema.check(
    Schema.makeFilter((value) =>
      value.split("||").every((group) => {
        const tokens = group.trim().split(/\s+/);
        return tokens.every((token) => /^(?:\^|>=|>|<=|<|=)?v?\d+(?:\.\d+){0,2}$/.test(token));
      }),
    ),
  ),
);
/** A styal release version, nightlies included (`0.1.1-nightly.20261015.730`). */
const StyalVersion = TrimmedNonEmptyString.pipe(
  Schema.check(Schema.makeFilter((value) => /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(value))),
);

/**
 * One provider release the provider canary verified against the published
 * styal build `styal`. It applies to servers whose code contains that build;
 * see `styalBuildContains`.
 */
const AutoUpdate = Schema.Struct({
  version: StableVersion,
  /** npm package that was installed; installs of another package are not updated. */
  package: TrimmedNonEmptyString,
  styal: StyalVersion,
});

const Policy = Schema.Struct({
  driver: TrimmedNonEmptyString,
  t3CodeRange: VersionRange,
  recommendedRange: Schema.optionalKey(VersionRange),
  recommendedVersion: Schema.optionalKey(StableVersion),
  /**
   * Provider releases automatic updates may install, recorded by
   * scripts/provider-canary.ts. Servers install the newest entry that applies
   * to them and never anything newer.
   */
  autoUpdates: Schema.optionalKey(Schema.Array(AutoUpdate)),
  ranges: Schema.Array(
    Schema.Struct({
      range: VersionRange,
      status: ServerProviderCompatibilityStatus,
    }),
  ),
});

const isSupportedVersion = (policy: typeof Policy.Type, version: string) =>
  policy.ranges.find((entry) => satisfiesSemverRange(version, entry.range))?.status === "supported";

export const ProviderCompatibilityPolicy = Policy.pipe(
  Schema.check(
    Schema.makeFilter(
      (policy) => {
        const version = policy.recommendedVersion;
        if (version === undefined) return true;
        return (
          (policy.recommendedRange === undefined ||
            satisfiesSemverRange(version, policy.recommendedRange)) &&
          isSupportedVersion(policy, version)
        );
      },
      { expected: "a recommended version in a supported range" },
    ),
    Schema.makeFilter(
      (policy) =>
        (policy.autoUpdates ?? []).every((entry) => isSupportedVersion(policy, entry.version)),
      { expected: "automatic update versions in a supported range" },
    ),
  ),
);
export type ProviderCompatibilityPolicy = typeof ProviderCompatibilityPolicy.Type;

function findPolicy(
  policies: ReadonlyArray<ProviderCompatibilityPolicy> | undefined,
  driver: ProviderDriverKind,
  t3CodeVersion: string,
): ProviderCompatibilityPolicy | undefined {
  return policies?.find(
    (entry) => entry.driver === driver && satisfiesSemverRange(t3CodeVersion, entry.t3CodeRange),
  );
}

/**
 * The plain `x.y.z` form of a provider's reported version, or null for
 * prereleases and unrecognized release tags.
 */
export function stableProviderVersion(
  driver: ProviderDriverKind,
  version: string | null | undefined,
): string | null {
  const unprefixed = version?.replace(/^v/, "");
  // Strip Cursor build hashes, Google ACP release prefixes and Muse revisions; leave semver prereleases unknown.
  const stable =
    driver === "cursor"
      ? unprefixed?.replace(/^(\d{4}\.\d{2}\.\d{2})-[a-f0-9]+$/, "$1")
      : driver === "antigravity"
        ? unprefixed?.replace(/^agy_acp_server_(\d+\.\d+\.\d+)$/, "$1")
        : driver === "muse"
          ? unprefixed?.replace(/^(\d+\.\d+\.\d+)-R\d+(?:\.\d+)?$/, "$1")
          : unprefixed;
  return stable && /^\d+\.\d+\.\d+$/.test(stable) ? stable : null;
}

/**
 * Later nightlies contain earlier ones. A stable release is rebuilt from some nightly of its own
 * version, possibly older than `tested`, so it contains only nightlies of earlier versions (stable
 * 0.1.2 contains every 0.1.1-nightly) and stable releases at or before it.
 */
export function styalBuildContains(version: string, tested: string): boolean {
  const isNightly = (value: string) => value.includes("-");
  if (isNightly(version) || !isNightly(tested)) return compareSemverVersions(version, tested) >= 0;
  return compareSemverVersions(version, tested.slice(0, tested.indexOf("-"))) > 0;
}

/**
 * The newest canary-verified version of `packageName` for this styal release,
 * or null. Only the remote manifest counts: removing an entry on `main`
 * withdraws it, which a bundled copy could not undo.
 */
export function resolveProviderAutoUpdateVersion(
  policies: ReadonlyArray<ProviderCompatibilityPolicy> | undefined,
  driver: ProviderDriverKind,
  packageName: string | null,
  t3CodeVersion = packageJson.version,
): string | null {
  let best: string | null = null;
  for (const entry of findPolicy(policies, driver, t3CodeVersion)?.autoUpdates ?? []) {
    if (entry.package !== packageName) continue;
    if (!styalBuildContains(t3CodeVersion, entry.styal)) continue;
    if (best === null || compareSemverVersions(entry.version, best) > 0) best = entry.version;
  }
  return best;
}

/** A manifest older than this may still list a version that was since withdrawn. */
const AUTO_UPDATE_MANIFEST_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1_000;

/**
 * The version automatic updates install for `packageName`: the newest verified
 * entry in a remote manifest fetched in the last two days, or null.
 */
export function resolveRecentProviderAutoUpdateVersion(
  remote: {
    readonly manifest: {
      readonly compatibility?: ReadonlyArray<ProviderCompatibilityPolicy> | undefined;
    };
    readonly fetchedAtMs: number;
  } | null,
  nowMs: number,
  driver: ProviderDriverKind,
  packageName: string | null,
): string | null {
  if (
    remote === null ||
    nowMs < remote.fetchedAtMs ||
    nowMs - remote.fetchedAtMs > AUTO_UPDATE_MANIFEST_MAX_AGE_MS
  )
    return null;
  return resolveProviderAutoUpdateVersion(remote.manifest.compatibility, driver, packageName);
}

export function resolveProviderCompatibility(
  policies: ReadonlyArray<ProviderCompatibilityPolicy> | undefined,
  driver: ProviderDriverKind,
  version: string | null,
  t3CodeVersion = packageJson.version,
): ServerProviderCompatibilityAdvisory | undefined {
  const policy = findPolicy(policies, driver, t3CodeVersion);
  if (!policy) return undefined;
  const stable = stableProviderVersion(driver, version);
  const status = stable
    ? (policy.ranges.find((entry) => satisfiesSemverRange(stable, entry.range))?.status ??
      "unknown")
    : "unknown";
  const message =
    status === "broken"
      ? "This provider version is known to be incompatible with this styal release."
      : status === "unsupported"
        ? "This provider version is outside the supported range for this styal release."
        : status === "graceful"
          ? "This provider version has limited compatibility with this styal release."
          : null;
  const recommendedVersion = policy.recommendedVersion ?? null;
  const recommendedRange = policy.recommendedRange ?? null;
  const recommendation = recommendedVersion ?? recommendedRange;
  return {
    status,
    message: message && recommendation ? `${message} Use ${recommendation}.` : message,
    recommendedVersion,
    recommendedRange,
  };
}

/**
 * A remote policy replaces its matching bundled policy; omission keeps the
 * bundle. `verifiedVersion` comes from `resolveRecentProviderAutoUpdateVersion`.
 */
export function applyProviderCompatibility(
  snapshot: ServerProvider,
  policies: ReadonlyArray<ProviderCompatibilityPolicy> | undefined,
  fallback: ReadonlyArray<ProviderCompatibilityPolicy> | undefined,
  verifiedVersion: string | null = null,
): ServerProvider {
  const { compatibilityAdvisory: _previous, ...base } = snapshot;
  if (!snapshot.enabled || !snapshot.installed) return base;
  const advisory =
    resolveProviderCompatibility(policies, snapshot.driver, snapshot.version) ??
    resolveProviderCompatibility(fallback, snapshot.driver, snapshot.version);
  const latestVersion = snapshot.versionAdvisory?.latestVersion;
  const latestAdvisory = latestVersion
    ? (resolveProviderCompatibility(policies, snapshot.driver, latestVersion) ??
      resolveProviderCompatibility(fallback, snapshot.driver, latestVersion))
    : undefined;
  const updateCommand = snapshot.versionAdvisory?.updateCommand;
  // The maintenance resolver emits this command only for confirmed Homebrew installs.
  const needsHomebrewRefresh =
    updateCommand?.startsWith("brew upgrade ") &&
    (advisory?.status === "unsupported" || advisory?.status === "broken") &&
    (latestAdvisory?.status === "unsupported" || latestAdvisory?.status === "broken");
  return advisory
    ? {
        ...base,
        compatibilityAdvisory: {
          ...advisory,
          message: needsHomebrewRefresh
            ? `${advisory.message} Homebrew's local package metadata may be stale. Run brew update && ${updateCommand} on this environment's host, then refresh provider status.`
            : advisory.message,
          ...(latestAdvisory ? { latestVersionStatus: latestAdvisory.status } : {}),
          ...(verifiedVersion ? { verifiedVersion } : {}),
        },
      }
    : base;
}
