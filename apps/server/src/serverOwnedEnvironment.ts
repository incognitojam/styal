import { BOOT_SERVICE_UNIT_ENV } from "./cloud/bootService.ts";
import { SERVICE_LAUNCHER_CONTEXT_ENV } from "./cloud/serviceProtocol.ts";

const SERVER_OWNED_ENV_KEYS = new Set([
  "STYAL_HOME",
  "PORT",
  "ELECTRON_RENDERER_PORT",
  "ELECTRON_RUN_AS_NODE",
  SERVICE_LAUNCHER_CONTEXT_ENV,
  BOOT_SERVICE_UNIT_ENV,
]);

/**
 * True for variables that configure this server process rather than the
 * user's session: its own settings (`T3CODE_*`, `STYAL_HOME`), whatever
 * launched it (the service launcher, Electron), and the dev web build
 * (`VITE_*`, `PORT`). A second styal server started from a child that inherits
 * them adopts this server's identity — its port, its state directory, its
 * Tailscale Serve mapping.
 */
export function isServerOwnedEnvKey(key: string): boolean {
  const normalizedKey = key.toUpperCase();
  return (
    normalizedKey.startsWith("T3CODE_") ||
    normalizedKey.startsWith("VITE_") ||
    SERVER_OWNED_ENV_KEYS.has(normalizedKey)
  );
}

/**
 * The environment a terminal or provider process should inherit from the
 * server. Deliberately a blocklist: an allowlist silently strips things like
 * PSModulePath, DISPLAY, proxies, and toolchain variables. `keep` names
 * server-prefixed variables that are addressed to the child.
 */
export function stripServerOwnedEnvironment(
  env: NodeJS.ProcessEnv,
  keep: ReadonlyArray<string> = [],
): NodeJS.ProcessEnv {
  const stripped: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (isServerOwnedEnvKey(key) && !keep.includes(key)) continue;
    stripped[key] = value;
  }
  return stripped;
}
