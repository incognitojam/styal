import type {
  EnvironmentId,
  ServerConfig,
  ServerInstallation,
  ServerSelfUpdateCapability,
} from "@t3tools/contracts";
import type { ServerUpdateState } from "@t3tools/client-runtime/state/server";
import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";
import * as Schema from "effect/Schema";

import { CLI_PACKAGE_NAME } from "@t3tools/shared/cliPackage";

import { APP_VERSION } from "./branding";
import { getLocalStorageItem, setLocalStorageItem } from "./hooks/useLocalStorage";

export interface VersionMismatch {
  readonly clientVersion: string;
  readonly serverVersion: string;
  readonly hint: string;
}

const VERSION_MISMATCH_DISMISSALS_STORAGE_KEY = "styal:version-mismatch-dismissals:v1";

const dismissedServerUpdateFailures = new WeakSet<ServerUpdateState>();

export function isServerUpdateFailureDismissed(state: ServerUpdateState): boolean {
  return state.status === "failed" && dismissedServerUpdateFailures.has(state);
}

export function dismissServerUpdateFailure(state: ServerUpdateState): void {
  if (state.status === "failed") dismissedServerUpdateFailures.add(state);
}

const VersionMismatchDismissalsSchema = Schema.Struct({
  keys: Schema.Array(Schema.String),
});

type VersionMismatchDismissals = typeof VersionMismatchDismissalsSchema.Type;

function normalizeVersion(version: string | null | undefined): string | null {
  const trimmed = version?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function versionCore(version: string): string {
  return version.replace(/[-+].*$/, "");
}

/**
 * The skew a user can act on: the connected server runs an older styal than
 * this client (or than `clientVersion`, the version this client is about to
 * update to), so the server is the side that needs updating.
 *
 * Two nightly builds compare their full versions, including the date and run.
 * Other combinations compare their core `major.minor.patch` only, so a stable
 * build and a nightly build with the same core do not cause an update warning.
 * A server ahead of the client does not need an update. Versions that do not
 * parse as semver fall back to plain string inequality.
 */
export function resolveVersionMismatch(
  serverVersion: string | null | undefined,
  clientVersion: string = APP_VERSION,
): VersionMismatch | null {
  const normalizedClientVersion = normalizeVersion(clientVersion);
  const normalizedServerVersion = normalizeVersion(serverVersion);
  if (!normalizedClientVersion || !normalizedServerVersion) {
    return null;
  }

  const clientCore = versionCore(normalizedClientVersion);
  const serverCore = versionCore(normalizedServerVersion);
  const compareNightlyBuilds =
    parseSemver(normalizedClientVersion)?.prerelease[0] === "nightly" &&
    parseSemver(normalizedServerVersion)?.prerelease[0] === "nightly";
  const serverIsBehind =
    parseSemver(clientCore) && parseSemver(serverCore)
      ? compareSemverVersions(
          compareNightlyBuilds ? normalizedServerVersion : serverCore,
          compareNightlyBuilds ? normalizedClientVersion : clientCore,
        ) < 0
      : normalizedServerVersion !== normalizedClientVersion;
  if (!serverIsBehind) {
    return null;
  }

  return {
    clientVersion: normalizedClientVersion,
    serverVersion: normalizedServerVersion,
    hint: "Version mismatch. Try syncing the client and server to the same styal version.",
  };
}

export function resolveServerConfigVersionMismatch(
  serverConfig: Pick<ServerConfig, "environment"> | null | undefined,
): VersionMismatch | null {
  return resolveVersionMismatch(serverConfig?.environment.serverVersion);
}

export type ServerUpdateCapability = ServerSelfUpdateCapability | "service-migration";

/** Selects the update action, requiring a local migration for legacy packages. */
export function resolveServerSelfUpdateCapability(
  serverConfig: Pick<ServerConfig, "environment"> | null | undefined,
): ServerUpdateCapability | null {
  const capability = serverConfig?.environment.capabilities.serverSelfUpdate ?? null;
  if (capability === "desktop-managed") return capability;
  if (serverConfig?.environment.serverPackageName !== CLI_PACKAGE_NAME) {
    return capability === "boot-service" ? "service-migration" : null;
  }
  return capability;
}

export function supportsDesktopAppUpdate(
  serverConfig: Pick<ServerConfig, "environment"> | null | undefined,
): boolean {
  return serverConfig?.environment.capabilities.desktopAppUpdate === true;
}

/** True when the connected server continues opted-in running turns after a
    restart and reports which threads will continue in its host activity. */
export function supportsServerUpdateThreadContinuation(
  serverConfig: Pick<ServerConfig, "environment"> | null | undefined,
): boolean {
  return serverConfig?.environment.capabilities.threadRestartContinuation === true;
}

/**
 * Manual commands require an explicit choice of how the server is run. A
 * foreground server that proved a global npm install updates that install;
 * any other foreground server is relaunched with the runner that started it.
 */
export function manualServerUpdateCommand(
  targetVersion: string,
  mode: "service" | "foreground",
  installation?: ServerInstallation,
): string {
  if (mode === "service") return `npx ${CLI_PACKAGE_NAME}@${targetVersion} service update`;
  if (installation?.kind === "npm-global") {
    const prefix = `'${installation.prefix.replaceAll("'", "'\\''")}'`;
    return `npm install --global --prefix ${prefix} ${CLI_PACKAGE_NAME}@${targetVersion}`;
  }
  const runner =
    installation?.kind === "pnpm-dlx" ? "pnpm dlx" : installation?.kind === "bunx" ? "bunx" : "npx";
  return `${runner} ${CLI_PACKAGE_NAME}@${targetVersion} serve`;
}

/** One sentence telling the user how to resolve version skew for a server,
    matched to the update path it offers. */
export function serverUpdateGuidance(
  capability: ServerUpdateCapability | null,
  serverLabel: string = "server",
): string {
  switch (capability) {
    case "boot-service":
    case "respawn":
      return `Update the ${serverLabel} so they stay in sync.`;
    case "service-migration":
      return `Follow the update instructions on the ${serverLabel} once to migrate its launcher to styal.`;
    case "desktop-managed":
      return `Update the desktop app that runs the ${serverLabel}.`;
    default:
      return `Follow the update instructions for how the ${serverLabel} is installed.`;
  }
}

export function buildVersionMismatchDismissalKey(
  environmentId: EnvironmentId,
  mismatch: Pick<VersionMismatch, "clientVersion" | "serverVersion">,
): string {
  return `${environmentId}:${mismatch.clientVersion}:${mismatch.serverVersion}`;
}

function readVersionMismatchDismissals(): VersionMismatchDismissals {
  try {
    return (
      getLocalStorageItem(
        VERSION_MISMATCH_DISMISSALS_STORAGE_KEY,
        VersionMismatchDismissalsSchema,
      ) ?? { keys: [] }
    );
  } catch (error) {
    console.error("Could not read version-mismatch dismissals.", error);
    return { keys: [] };
  }
}

function writeVersionMismatchDismissals(document: VersionMismatchDismissals): void {
  try {
    setLocalStorageItem(
      VERSION_MISMATCH_DISMISSALS_STORAGE_KEY,
      document,
      VersionMismatchDismissalsSchema,
    );
  } catch (error) {
    console.error("Could not persist version-mismatch dismissals.", error);
  }
}

export function isVersionMismatchDismissed(dismissalKey: string | null | undefined): boolean {
  if (!dismissalKey) {
    return false;
  }
  return readVersionMismatchDismissals().keys.includes(dismissalKey);
}

export function dismissVersionMismatch(dismissalKey: string | null | undefined): void {
  if (!dismissalKey) {
    return;
  }
  const document = readVersionMismatchDismissals();
  if (document.keys.includes(dismissalKey)) {
    return;
  }
  writeVersionMismatchDismissals({
    keys: [...document.keys, dismissalKey],
  });
}
