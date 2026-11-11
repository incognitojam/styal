// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export const databaseCopyHeadroom = (size: number) => Math.max(1024 ** 3, size * 0.1);

export const runCp = (
  args: ReadonlyArray<string>,
  timeout = 0,
  signal?: AbortSignal,
): Promise<boolean> =>
  new Promise((resolve) => {
    NodeChildProcess.execFile(
      "cp",
      args,
      { timeout, ...(signal === undefined ? {} : { signal }) },
      (error) => resolve(error === null),
    );
  });

export async function cloneDatabaseFile(
  source: string,
  destination: string,
  signal?: AbortSignal,
): Promise<boolean> {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Filesystem clone support depends on the host OS.
  if (process.platform === "linux")
    return runCp(["--reflink=always", source, destination], 60000, signal);
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Windows uses the startup streaming fallback.
  if (process.platform !== "darwin") return false;
  const directory = NodePath.dirname(destination);
  const [file, target, filesystem, system] = await Promise.all([
    NodeFSP.stat(source),
    NodeFSP.stat(directory),
    NodeFSP.statfs(directory),
    NodeFSP.statfs("/"),
  ]);
  // cp -c can silently byte-copy across volumes or outside APFS.
  if (file.dev !== target.dev || filesystem.type !== system.type || file.nlink !== 1) return false;
  return runCp(["-c", source, destination], 60000, signal);
}

// macOS fs.copyFile clone flags fall back to full copies.
export async function copyDatabaseFile(source: string, destination: string): Promise<void> {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone launcher has no Effect runtime.
  const platform = process.platform;
  // cp -c replaces files and breaks hard links; copy into hard-linked destinations instead.
  const hardLinked =
    platform === "darwin" &&
    ((await NodeFSP.stat(destination).catch(() => undefined))?.nlink ?? 1) > 1;
  const args =
    platform === "darwin" && !hardLinked
      ? ["-c", source, destination]
      : platform === "linux"
        ? ["--reflink=auto", source, destination]
        : undefined;
  if (args === undefined || !(await runCp(args))) await NodeFSP.copyFile(source, destination);
}
