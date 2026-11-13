// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off - a settle action must run even if the install is broken.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";

// Stripping is opt-in. Do not save --strip-regenerable in a settle action until reinstall-on-reopen exists.
const gitEnv = () => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_")),
  ),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: NodeOS.devNull,
});

function git(worktree: string, args: ReadonlyArray<string>): string {
  const result = NodeChildProcess.spawnSync("git", ["-C", worktree, ...args], {
    encoding: "utf8",
    env: gitEnv(),
  });
  if (result.status !== 0) throw new Error("Could not verify worktree with git.");
  return result.stdout.trim();
}

function verifyWorktree(worktree: string): string {
  const root = NodeFS.realpathSync(worktree);
  if (NodeFS.realpathSync(process.cwd()) !== root)
    throw new Error("Must run inside the target worktree.");
  if (git(root, ["rev-parse", "--show-toplevel"]) !== root)
    throw new Error("Target is not a worktree root.");
  const gitDir = NodeFS.realpathSync(git(root, ["rev-parse", "--absolute-git-dir"]));
  const common = NodeFS.realpathSync(
    NodePath.resolve(root, git(root, ["rev-parse", "--git-common-dir"])),
  );
  if (gitDir === common) throw new Error("Refusing the main checkout.");
  const registeredDotGit = NodeFS.readFileSync(NodePath.join(gitDir, "gitdir"), "utf8").trim();
  if (NodeFS.realpathSync(registeredDotGit) !== NodeFS.realpathSync(NodePath.join(root, ".git")))
    throw new Error("Target does not match its registered worktree metadata.");
  if (
    !root
      .split(NodePath.sep)
      .some(
        (part, index, parts) =>
          part === "worktrees" && (parts[index - 1] === ".styal" || parts[index - 1] === "styal"),
      )
  )
    throw new Error("Target is outside a styal worktrees directory.");
  return root;
}

const REGENERABLE_DIRECTORIES = new Set([
  "node_modules",
  ".turbo",
  "dist",
  "build",
  ".vite",
  ".vite-plus",
  "coverage",
]);
const REGENERABLE_PATHS = new Set([
  ".styal/setup-done",
  ".styal/caches",
  ".styal/dev-runners",
  "apps/mobile/.expo",
  "apps/mobile/web-build",
  "apps/mobile/.android-cache",
  "apps/mobile/android/.gradle",
  "apps/mobile/android/.kotlin",
  "apps/mobile/ios/Pods",
  "apps/mobile/ios/.build",
  "apps/server/dist-exe",
  "dist-electron",
  "apps/desktop/dist-electron",
]);
const normalizeName = (name: string) => name.normalize("NFKC").toLowerCase();
const protectedName = (raw: string) => {
  const name = normalizeName(raw);
  return (
    name === ".git" ||
    name === ".repos" ||
    name === ".scratch" ||
    name.startsWith(".env") ||
    name === "test-results"
  );
};
const protectedRelative = (relative: string) => {
  const normalized = relative.split(NodePath.sep).map(normalizeName).join("/");
  return (
    normalized === ".styal/userdata" ||
    normalized.endsWith("/.styal/userdata") ||
    normalized === ".styal/worktrees"
  );
};

const fileIdentity = (path: string) => {
  const info = NodeFS.lstatSync(path, { bigint: true });
  return { dev: String(info.dev), ino: String(info.ino) };
};

function safeTree(root: string, relative: string) {
  const ancestors: Array<{ path: string; dev: string; ino: string }> = [];
  const entries: typeof ancestors = [];
  const components = relative.split(NodePath.sep);
  for (let index = 1; index <= components.length; index++) {
    const part = components.slice(0, index).join(NodePath.sep);
    const absolute = NodePath.join(root, part);
    if (NodeFS.lstatSync(absolute).isSymbolicLink()) return undefined;
    if (index < components.length) ancestors.push({ path: part, ...fileIdentity(absolute) });
  }
  if (!NodeFS.realpathSync(NodePath.join(root, relative)).startsWith(root + NodePath.sep))
    return undefined;
  const paths: Array<string> = [];
  function visit(target: string): boolean {
    const absolute = NodePath.join(root, target);
    const stat = NodeFS.lstatSync(absolute);
    if (protectedName(NodePath.basename(target)) || protectedRelative(target)) return false;
    try {
      const resolved = stat.isSymbolicLink()
        ? NodeFS.realpathSync(absolute)
        : NodePath.resolve(absolute);
      if (!resolved.startsWith(root + NodePath.sep)) return false;
    } catch {
      return false;
    }
    paths.push(target);
    entries.push({ path: target, ...fileIdentity(absolute) });
    if (stat.isSymbolicLink()) return true;
    if (!stat.isDirectory()) return stat.isFile();
    if (NodeFS.existsSync(NodePath.join(absolute, ".git"))) return false;
    return NodeFS.readdirSync(absolute).every((name) => visit(NodePath.join(target, name)));
  }
  if (!visit(relative)) return undefined;
  const result = NodeChildProcess.spawnSync("git", ["-C", root, "check-ignore", "--stdin", "-z"], {
    encoding: "utf8",
    env: gitEnv(),
    input: paths.join("\0") + "\0",
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.status === 0 && result.stdout.split("\0").length - 1 === paths.length
    ? { ancestors, entries }
    : undefined;
}

function sizeOf(absolute: string): number {
  const stat = NodeFS.lstatSync(absolute);
  if (stat.isSymbolicLink()) return 0;
  return stat.isDirectory()
    ? NodeFS.readdirSync(absolute).reduce(
        (sum, name) => sum + sizeOf(NodePath.join(absolute, name)),
        0,
      )
    : stat.size;
}

function hasPackageManifest(directory: string): boolean {
  try {
    return NodeFS.lstatSync(NodePath.join(directory, "package.json")).isFile();
  } catch {
    return false;
  }
}

function selectRegenerable(root: string): Array<{ path: string; bytes: number }> {
  const selected: Array<{ path: string; bytes: number }> = [];
  function visit(relative: string) {
    const absolute = NodePath.join(root, relative);
    const stat = NodeFS.lstatSync(absolute);
    if (
      stat.isSymbolicLink() ||
      protectedName(NodePath.basename(relative)) ||
      protectedRelative(relative)
    )
      return;
    if (stat.isDirectory() && relative !== "" && NodeFS.existsSync(NodePath.join(absolute, ".git")))
      return;
    const candidate =
      REGENERABLE_PATHS.has(relative) ||
      (stat.isDirectory() &&
        REGENERABLE_DIRECTORIES.has(NodePath.basename(relative)) &&
        (NodePath.basename(relative) === "node_modules" ||
          (NodeFS.lstatSync(NodePath.dirname(absolute)).isDirectory() &&
            hasPackageManifest(NodePath.dirname(absolute))))) ||
      (stat.isFile() && relative.endsWith(".tsbuildinfo"));
    if (candidate) {
      if (safeTree(root, relative)) selected.push({ path: relative, bytes: sizeOf(absolute) });
      else console.log(`[teardown] keeping protected or unignored candidate: ${relative}`);
      return;
    }
    if (stat.isDirectory())
      for (const name of NodeFS.readdirSync(absolute)) visit(NodePath.join(relative, name));
  }
  visit("");
  return selected;
}

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
function devServerProcesses(
  worktree: string,
  workspacePort: number | undefined,
): ReadonlyArray<number> {
  const runners = NodeFS.existsSync(NodePath.join(worktree, DEV_RUNNERS_PATH))
    ? NodeFS.readdirSync(NodePath.join(worktree, DEV_RUNNERS_PATH)).map(Number)
    : [];
  // Without a reserved range the dev runner picked its own ports, so only its record finds it.
  const listeners =
    workspacePort === undefined
      ? []
      : lsof([
          "-t",
          `-itcp:${workspacePort}-${workspacePort + WORKSPACE_PORT_COUNT - 1}`,
          "-sTCP:LISTEN",
        ])
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

async function stopDevServers(worktree: string, workspacePort: number | undefined): Promise<void> {
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
): { readonly worktree: string; readonly workspacePort: number | undefined } | undefined {
  const worktree = env.STYAL_WORKTREE_PATH;
  // styal leaves the port unset when no range was free; a set but invalid value is a mistake.
  const workspacePort =
    env.STYAL_WORKSPACE_PORT === undefined ? undefined : Number(env.STYAL_WORKSPACE_PORT);
  if (!worktree) return undefined;
  if (workspacePort !== undefined && (!Number.isInteger(workspacePort) || workspacePort <= 0))
    return undefined;
  try {
    if (NodeFS.realpathSync(worktree) !== NodeFS.realpathSync(checkout)) return undefined;
    return { worktree: verifyWorktree(worktree), workspacePort };
  } catch {
    return undefined;
  }
}

export async function teardownWorktree(input: {
  readonly worktree: string;
  readonly workspacePort: number | undefined;
  readonly dryRun?: boolean;
  readonly stripRegenerable?: boolean;
}): Promise<void> {
  const root = verifyWorktree(input.worktree);
  const rootIdentity = fileIdentity(root);
  const dryRun = input.dryRun === true || input.stripRegenerable !== true;
  if (input.dryRun !== true) await stopDevServers(root, input.workspacePort);
  const userdata = NodePath.join(root, ".styal/userdata");
  console.log(
    `[teardown] keeping .styal/userdata: ${NodeFS.existsSync(userdata) ? sizeOf(userdata) : 0} bytes`,
  );
  const selected = selectRegenerable(root);
  let bytes = 0;
  let count = 0;
  const removed: Array<string> = [];
  let notDeleted = selected.map((entry) => entry.path);
  let rootDescriptor: number | undefined;
  try {
    for (const entry of selected) {
      if (!dryRun) {
        const checked = safeTree(root, entry.path);
        if (!checked) throw new Error("Cleanup candidate changed; refusing deletion.");
        if (rootDescriptor === undefined) {
          if (!NodeFS.constants.O_NOFOLLOW || !NodeFS.constants.O_DIRECTORY)
            throw new Error("Descriptor-relative deletion is unavailable on this platform.");
          rootDescriptor = NodeFS.openSync(
            root,
            NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_DIRECTORY,
          );
          const opened = NodeFS.fstatSync(rootDescriptor, { bigint: true });
          if (String(opened.dev) !== rootIdentity.dev || String(opened.ino) !== rootIdentity.ino)
            throw new Error("Worktree root changed; refusing deletion.");
        }
        // Node has no unlinkat; the stdlib helper deletes relative to inherited directory handles.
        const result = NodeChildProcess.spawnSync(
          "python3",
          ["-I", "-S", NodePath.join(import.meta.dirname, "teardown-worktree-delete.py")],
          {
            input: JSON.stringify({ root: rootIdentity, candidate: entry.path, ...checked }),
            encoding: "utf8",
            stdio: ["pipe", "pipe", "pipe", rootDescriptor],
            maxBuffer: 64 * 1024 * 1024,
          },
        );
        if (result.error || !result.stdout)
          throw new Error("Descriptor-relative deletion helper could not run.", {
            cause: result.error,
          });
        const report = JSON.parse(result.stdout) as {
          removed: Array<string>;
          bytes: number;
          remaining: Array<string>;
          error?: string;
        };
        removed.push(...report.removed);
        bytes += report.bytes;
        notDeleted = [...report.remaining, ...selected.slice(count + 1).map((next) => next.path)];
        if (result.status !== 0)
          throw new Error(report.error ?? "Descriptor-relative deletion failed.");
      } else bytes += entry.bytes;
      count++;
      console.log(
        `[teardown] ${dryRun ? "would remove" : "removed"} ${entry.path}: ${entry.bytes} bytes`,
      );
    }
  } catch (cause) {
    console.error(
      `[teardown] removed before failure: ${JSON.stringify(removed)}; ${bytes} logical bytes`,
    );
    console.error(`[teardown] not deleted: ${JSON.stringify(notDeleted)}`);
    throw cause;
  } finally {
    if (rootDescriptor !== undefined) NodeFS.closeSync(rootDescriptor);
  }
  console.log(
    `[teardown] ${dryRun ? "dry run: would remove" : "removed"} ${count} paths, ${bytes} bytes ${dryRun ? "reclaimable" : "freed (logical size)"}`,
  );
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--dry-run" && arg !== "--strip-regenerable"))
    throw new Error("Only --dry-run and --strip-regenerable are supported.");
  const dryRun = args.includes("--dry-run");
  const target = resolveTeardownTarget(
    dryRun ? { ...process.env, STYAL_WORKTREE_PATH: process.cwd() } : process.env,
    process.cwd(),
  );
  if (target === undefined) {
    console.error(
      "[teardown] refusing to run: STYAL_WORKTREE_PATH must name this worktree. Run this as a settle action.",
    );
    process.exitCode = 1;
  } else {
    await teardownWorktree({
      ...target,
      dryRun,
      stripRegenerable: args.includes("--strip-regenerable"),
    });
  }
}
