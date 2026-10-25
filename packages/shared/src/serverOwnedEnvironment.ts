/** Set by the service launcher for the server it runs. */
export const SERVICE_LAUNCHER_CONTEXT_ENV = "T3_SERVICE_LAUNCHER_CONTEXT";
/** Set by the boot service unit for the server it starts. */
export const BOOT_SERVICE_UNIT_ENV = "T3_BOOT_SERVICE_UNIT";

const SERVER_OWNED_ENV_KEYS = new Set([
  "STYAL_HOME",
  "PORT",
  "ELECTRON_RENDERER_PORT",
  "ELECTRON_RUN_AS_NODE",
  SERVICE_LAUNCHER_CONTEXT_ENV,
  BOOT_SERVICE_UNIT_ENV,
]);

/**
 * A styal server started from a child process that inherits these would use this server's
 * port, state directory, and Tailscale Serve mapping.
 */
function isServerOwnedEnvKey(key: string): boolean {
  const normalizedKey = key.toUpperCase();
  return (
    normalizedKey.startsWith("T3CODE_") ||
    normalizedKey.startsWith("VITE_") ||
    SERVER_OWNED_ENV_KEYS.has(normalizedKey)
  );
}

/**
 * Returns `env` without the server-owned variables, for terminals and provider
 * processes. This is a blocklist because an allowlist would also remove
 * variables users rely on, such as PSModulePath, DISPLAY, proxy settings, and
 * toolchain variables. Names listed in `keep` are not removed.
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
