import type { ProviderMaintenanceResolutionContext } from "@t3tools/provider-core/server/maintenanceResolver";

export const CODEX_INSTALL_SCRIPT_URL = "https://chatgpt.com/codex/install.sh";

// The script `codex update` runs, saved first so a failed download fails the
// install rather than piping nothing to `sh`. `$1` is the release to install.
const CODEX_PINNED_INSTALL_SCRIPT = [
  "set -eu",
  'script="$(mktemp)"',
  "trap 'rm -f \"$script\"' EXIT",
  `curl -fsSL ${CODEX_INSTALL_SCRIPT_URL} -o "$script"`,
  '/bin/sh "$script" --release "$1"',
].join("\n");

/**
 * Installs exactly `version` into a standalone Codex install the way
 * `codex update` does, against the tree under the shared `CODEX_HOME`.
 *
 * The script's `CODEX_INSTALL_IF_CURRENT` compare-and-swap guard is not used:
 * it refuses every pinned release ("Daemon selection changed"), so the
 * updater's fresh version check under the install lock stands in for it.
 * The script is pointed at the directory of the `codex` on PATH, with that
 * directory on its PATH, so it does not add a PATH block to a shell profile.
 * A pinned install leaves Codex's own latest-channel auto-update until the
 * next `codex update`.
 */
export function makeCodexPinnedInstall(sharedHomePath: string) {
  return (
    version: string,
    context: Pick<ProviderMaintenanceResolutionContext, "resolvedCommandPath" | "env">,
  ) => {
    const visible = context.resolvedCommandPath;
    const binDir = visible.includes("/packages/standalone/")
      ? null
      : visible.slice(0, visible.lastIndexOf("/"));
    return {
      executable: "/bin/sh",
      args: ["-c", CODEX_PINNED_INSTALL_SCRIPT, "codex-install", version],
      env: {
        CODEX_HOME: sharedHomePath,
        CODEX_NON_INTERACTIVE: "1",
        ...(binDir
          ? {
              CODEX_INSTALL_DIR: binDir,
              PATH: context.env.PATH ? `${binDir}:${context.env.PATH}` : binDir,
            }
          : {}),
      },
      command: `curl -fsSL ${CODEX_INSTALL_SCRIPT_URL} | sh -s -- --release ${version}`,
    };
  };
}
