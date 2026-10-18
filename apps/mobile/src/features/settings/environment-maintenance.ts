import {
  AuthEnvironmentMaintainScope,
  sessionGrantsScope,
  type AuthSessionState,
  type ExecutionEnvironmentCapabilities,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  CLI_NPM_DIST_TAGS_URL,
  cliReleaseChannelOf,
  cliReleaseChecksumsUrl,
  cliReleasePendingMessage,
  cliReleaseVersionFromDistTags,
} from "@t3tools/shared/cliRelease";
import { compareSemverVersions } from "@t3tools/shared/semver";

export function canMaintainEnvironment(session: AuthSessionState | null, connected: boolean) {
  return (
    connected &&
    session?.authenticated === true &&
    sessionGrantsScope(session, AuthEnvironmentMaintainScope)
  );
}

export function supportsEnvironmentUpdate(
  capabilities: Pick<ExecutionEnvironmentCapabilities, "serverSelfUpdate" | "desktopAppUpdate">,
) {
  return (
    capabilities.serverSelfUpdate !== undefined &&
    (capabilities.serverSelfUpdate !== "desktop-managed" || capabilities.desktopAppUpdate === true)
  );
}

export function canUpdateEnvironmentProvider(provider: ServerProvider) {
  const compatibility = provider.compatibilityAdvisory?.latestVersionStatus;
  return (
    provider.installed &&
    provider.availability !== "unavailable" &&
    provider.versionAdvisory?.status === "behind_latest" &&
    provider.versionAdvisory.canUpdate &&
    provider.versionAdvisory.latestVersion !== null &&
    compatibility !== "broken" &&
    compatibility !== "unsupported" &&
    provider.updateState?.status !== "running" &&
    provider.updateState?.status !== "queued"
  );
}

/** Whether the latest release is newer than the version the provider canary verified. */
export function isLatestProviderVersionUntested(provider: ServerProvider) {
  const latest = provider.versionAdvisory?.latestVersion;
  const verified = provider.compatibilityAdvisory?.verifiedVersion;
  return Boolean(latest && verified && compareSemverVersions(latest, verified) > 0);
}

/** Preserve the host's release channel and never offer a downgrade. */
export async function findEnvironmentUpdate(currentVersion: string, signal: AbortSignal) {
  const channel = cliReleaseChannelOf(currentVersion);
  const response = await fetch(CLI_NPM_DIST_TAGS_URL, { signal });
  if (!response.ok) throw new Error(`Could not check releases (${response.status}). Try again.`);
  const version = cliReleaseVersionFromDistTags(await response.json(), channel);
  if (compareSemverVersions(version, currentVersion) <= 0) return null;
  const assets = await fetch(cliReleaseChecksumsUrl(version), { method: "HEAD", signal });
  if (!assets.ok) throw new Error(cliReleasePendingMessage(version));
  return version;
}
