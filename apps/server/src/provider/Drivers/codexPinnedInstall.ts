import type { ProviderMaintenanceResolutionContext } from "@t3tools/provider-core/server/maintenanceResolver";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

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
 * `CODEX_INSTALL_IF_CURRENT` refuses every pinned release, so the updater's version check under
 * the install lock replaces it. Putting the target directory on PATH stops the script editing a
 * shell profile. A pinned install removes Codex's self-update marker until the next `codex update`.
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

/**
 * The install script writes `auto-update-version` for a latest-channel install and removes it
 * for a pinned one; Codex self-updates only while it names the release `current` points at.
 * Null when the files cannot be read.
 */
export const codexSelfUpdaterActive = Effect.fn("codexSelfUpdaterActive")(function* (
  sharedHomePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const standaloneRoot = path.join(sharedHomePath, "packages", "standalone");
  const markerPath = path.join(standaloneRoot, "auto-update-version");
  const markerExists = yield* fileSystem.exists(markerPath).pipe(Effect.orElseSucceed(() => null));
  if (markerExists !== true) return markerExists;
  const marker = yield* fileSystem
    .readFileString(markerPath)
    .pipe(Effect.orElseSucceed(() => null));
  const current = yield* fileSystem
    .realPath(path.join(standaloneRoot, "current"))
    .pipe(Effect.orElseSucceed(() => null));
  if (marker === null || current === null) return null;
  return path.basename(current) === marker.trim();
});
