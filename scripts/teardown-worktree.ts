// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off - a settle action must run even if the install is broken.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";

// Dev start and `vp run migrate-dev-db` recreate these. `.styal/worktrees` can hold uncommitted
// work and `.scratch` holds the thread's notes, so neither is listed.
export const TEMPORARY_PATHS = [".styal/userdata", ".styal/caches", ".styal/dev-runners"];

const DEV_RUNNERS_PATH = ".styal/dev-runners";

const WORKSPACE_PORT_COUNT = 10;
const STOP_WAIT_MS = 5_000;
const POLL_MS = 100;

function lsof(args: ReadonlyArray<string>): string {
  const result = NodeChildProcess.spawnSync("lsof", args, { encoding: "utf8" });
  if (result.error !== undefined) throw result.error;
  // lsof exits 1 when nothing matches, which is the expected end state here.
  return result.status === 0 ? result.stdout : "";
}

function runsInside(worktree: string, pid: number): boolean {
  const cwd = lsof(["-a", "-p", String(pid), "-d", "cwd", "-Fn"])
    .split("\n")
    .find((line) => line.startsWith("n"))
    ?.slice(1);
  if (cwd === undefined) return false;
  const relative = NodePath.relative(worktree, cwd);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
}

/** Stopping a runner stops its whole tree, including parts that listen on nothing. */
function devServerProcesses(worktree: string, workspacePort: number): ReadonlyArray<number> {
  const runners = NodeFS.existsSync(NodePath.join(worktree, DEV_RUNNERS_PATH))
    ? NodeFS.readdirSync(NodePath.join(worktree, DEV_RUNNERS_PATH)).map(Number)
    : [];
  const range = `tcp:${workspacePort}-${workspacePort + WORKSPACE_PORT_COUNT - 1}`;
  const listeners = lsof(["-t", `-i${range}`, "-sTCP:LISTEN"])
    .split("\n")
    .filter(Boolean)
    .map(Number);
  // A leftover file can name a PID since reused, so both sources need the same check.
  return [...new Set([...runners, ...listeners])].filter(
    (pid) => Number.isInteger(pid) && pid > 0 && runsInside(worktree, pid),
  );
}

/**
 * `vp run` does not pass SIGTERM to every task, so the desktop watcher and Electron outlive it.
 * Ctrl+C reaches them through the process group, so do the same, but only for a group entirely
 * inside this worktree: a tool can share a group with its agent or something else.
 */
function signalTargets(worktree: string, pids: ReadonlyArray<number>): ReadonlySet<number> {
  const table = NodeChildProcess.spawnSync("ps", ["-A", "-o", "pid=,pgid=,stat="], {
    encoding: "utf8",
  })
    .stdout.split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter(([pid, , stat]) => pid && !stat?.startsWith("Z"))
    .map(([pid, pgid]) => ({ pid: Number(pid), pgid: Number(pgid) }));
  const ownGroup = table.find((entry) => entry.pid === process.pid)?.pgid;
  const targets = new Set<number>();
  for (const pid of pids) {
    const pgid = table.find((entry) => entry.pid === pid)?.pgid;
    const members = table.filter((entry) => entry.pgid === pgid);
    const ownedGroup =
      pgid !== undefined &&
      pgid !== ownGroup &&
      members.every((entry) => runsInside(worktree, entry.pid));
    targets.add(ownedGroup ? -pgid : pid);
  }
  return targets;
}

const signalAll = (targets: ReadonlySet<number>, signal: NodeJS.Signals) => {
  for (const target of targets) {
    try {
      process.kill(target, signal);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;
    }
  }
};

async function stopDevServers(worktree: string, workspacePort: number): Promise<void> {
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    const remaining = devServerProcesses(worktree, workspacePort);
    if (remaining.length === 0) return;
    const targets = signalTargets(worktree, remaining);
    console.log(`[teardown] sending ${signal} to ${[...targets].join(", ")}`);
    signalAll(targets, signal);
    const deadline = Date.now() + STOP_WAIT_MS;
    while (Date.now() < deadline && devServerProcesses(worktree, workspacePort).length > 0) {
      await NodeTimersPromises.setTimeout(POLL_MS);
    }
  }
  const stuck = devServerProcesses(worktree, workspacePort);
  if (stuck.length > 0) throw new Error(`Could not stop ${stuck.join(", ")}.`);
}

/** Only ever a linked worktree a settling thread owns, so it cannot reach the main checkout. */
export function resolveTeardownTarget(
  env: NodeJS.ProcessEnv,
  checkout: string,
): { readonly worktree: string; readonly workspacePort: number } | undefined {
  const worktree = env.STYAL_WORKTREE_PATH;
  const workspacePort = Number(env.STYAL_WORKSPACE_PORT);
  if (!worktree || !Number.isInteger(workspacePort) || workspacePort <= 0) return undefined;
  if (NodeFS.realpathSync(worktree) !== NodeFS.realpathSync(checkout)) return undefined;
  return { worktree: NodeFS.realpathSync(worktree), workspacePort };
}

export async function teardownWorktree(input: {
  readonly worktree: string;
  readonly workspacePort: number;
}): Promise<void> {
  // Stop first: a server still running would keep writing to the state being deleted.
  await stopDevServers(input.worktree, input.workspacePort);
  for (const relativePath of TEMPORARY_PATHS) {
    NodeFS.rmSync(NodePath.join(input.worktree, relativePath), { recursive: true, force: true });
  }
  console.log(`[teardown] removed ${TEMPORARY_PATHS.join(", ")}`);
}

if (import.meta.main) {
  const target = resolveTeardownTarget(process.env, NodePath.dirname(import.meta.dirname));
  if (target === undefined) {
    console.error(
      "[teardown] refusing to run: STYAL_WORKTREE_PATH must name this worktree and STYAL_WORKSPACE_PORT must be set. Run this as a settle action.",
    );
    process.exitCode = 1;
  } else {
    await teardownWorktree(target);
  }
}
