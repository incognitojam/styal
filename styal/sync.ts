#!/usr/bin/env node
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const git = (...args: string[]) =>
  NodeChildProcess.execFileSync(
    "git",
    [
      "-c",
      "gc.auto=0",
      "-c",
      "maintenance.auto=false",
      "-c",
      "rerere.enabled=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  ).trim();
if (git("rev-parse", "--show-prefix")) throw new Error("Run sync from the repository root");
const args = process.argv.slice(2);
for (const arg of args) {
  if (arg.startsWith("--") && arg !== "--continue" && !arg.startsWith("--skip="))
    throw new Error(`Unknown option: ${arg}`);
}
const resume = args.includes("--continue");
let skip = args.filter((arg) => arg.startsWith("--skip=")).map((arg) => arg.slice(7));
const statePath = ".scratch/restart-sync-state.json";
const logPath = ".scratch/restart-sync.log";
NodeFS.mkdirSync(".scratch", { recursive: true });
if (NodeChildProcess.spawnSync("git", ["check-ignore", "-q", ".scratch"]).status !== 0)
  throw new Error("Ignore .scratch in git/info/exclude before syncing");
function log(message: string) {
  console.log(message);
  NodeFS.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
}
type State = {
  source: string;
  branch: string;
  base: string;
  tooling: string;
  features: { name: string; sha: string }[];
  index: number;
  head: string;
  conflicted: boolean;
  skipped: string[];
  started: number;
  phase: "identity" | "features";
};
let state: State;
const save = () => NodeFS.writeFileSync(statePath, JSON.stringify(state, null, 2));
if (resume) {
  state = JSON.parse(NodeFS.readFileSync(statePath, "utf8"));
  skip = [...new Set([...(state.skipped ?? []), ...skip])];
  state.skipped = skip;
  save();
  for (const name of skip)
    if (!state.features.some((f) => f.name === name)) throw new Error(`Unknown feature: ${name}`);
  if (git("branch", "--show-current") !== state.branch)
    throw new Error("Resume on the recorded sync branch");
  if (state.conflicted) {
    const feature = state.features[state.index]!;
    if (skip.includes(feature.name)) {
      if (git("rev-parse", "HEAD") !== state.head)
        throw new Error("HEAD changed; refusing to discard a manual commit");
      git("cherry-pick", "--abort");
      log(`SIT OUT ${feature.name}`);
    } else {
      if (git("diff", "--name-only", "--diff-filter=U"))
        throw new Error("Resolve and stage conflicts before --continue");
      git("-c", "core.editor=true", "cherry-pick", "--continue");
      log(`MANUAL ${feature.name}`);
    }
    state.index++;
    state.conflicted = false;
    state.head = git("rev-parse", "HEAD");
    save();
  }
  if (git("rev-parse", "HEAD") !== state.head) throw new Error("HEAD changed since sync stopped");
} else {
  const [baseArg, branch, sourceArg = "HEAD"] = args.filter((arg) => !arg.startsWith("--"));
  if (!baseArg || !branch?.startsWith("restart/"))
    throw new Error(
      "Usage: node styal/sync.ts <upstream-commit> restart/<branch> [source-ref] [--skip=name]; or --continue [--skip=name]",
    );
  if (git("status", "--porcelain", "--untracked-files=normal"))
    throw new Error("Sync needs a clean tree (including untracked files)");
  const source = git("rev-parse", `${sourceArg}^{commit}`);
  const base = git("rev-parse", `${baseArg}^{commit}`);
  if (git("ls-tree", base, "styal"))
    throw new Error("Upstream already owns styal/; refusing an overlay");
  const manifest = JSON.parse(git("show", `${source}:styal/features.json`)) as {
    name: string;
    subject: string;
  }[];
  if (new Set(manifest.map((f) => f.name)).size !== manifest.length)
    throw new Error("Duplicate features");
  for (const name of skip)
    if (!manifest.some((f) => f.name === name)) throw new Error(`Unknown feature: ${name}`);
  const features = manifest.map(({ name, subject }) => {
    const matches = git("log", source, "--format=%H%x09%s")
      .split("\n")
      .filter((line) => line.slice(41) === subject);
    if (matches.length !== 1)
      throw new Error(`Expected one source commit for ${name}, found ${matches.length}`);
    const sha = matches[0]!.slice(0, 40);
    if (git("rev-list", "--parents", "-n1", sha).split(" ").length !== 2)
      throw new Error(`Feature must be a single-parent commit: ${name}`);
    return { name, sha };
  });
  const archive = NodeChildProcess.execFileSync("git", ["archive", source, "styal"], {
    maxBuffer: 128 * 1024 * 1024,
  });
  git("switch", "-c", branch, base);
  const unpack = NodeChildProcess.spawnSync("tar", ["-x"], { input: archive });
  if (unpack.status !== 0) throw new Error("Cannot restore tooling");
  git("add", "styal");
  git("commit", "-m", "build(styal): add restart tooling");
  state = {
    source,
    branch,
    base,
    tooling: git("rev-parse", "HEAD"),
    features,
    index: 0,
    head: git("rev-parse", "HEAD"),
    conflicted: false,
    skipped: skip,
    started: Date.now(),
    phase: "identity",
  };
  save();
  log(`TOOLING clean ${source} -> ${base} on ${branch}`);
}
if (state.phase === "identity") {
  if (git("status", "--porcelain"))
    throw new Error("Identity failed: inspect edits before retrying from a fresh branch");
  NodeChildProcess.execFileSync("vp", ["i"], { stdio: "inherit" });
  NodeChildProcess.execFileSync(process.execPath, [NodePath.resolve("styal/identity.ts")], {
    stdio: "inherit",
  });
  git("add", "-A");
  git("commit", "-m", "build(styal): generate isolated product identity");
  state.phase = "features";
  state.head = git("rev-parse", "HEAD");
  save();
  log("IDENTITY clean");
}
log(
  "Run vp i before checking this head, and again after switching branches; the identity-stage install may lack feature dependencies.",
);
if (git("status", "--porcelain"))
  throw new Error("Uncommitted changes remain; refusing to apply features");
for (; state.index < state.features.length; state.index++) {
  const feature = state.features[state.index]!;
  if (skip.includes(feature.name)) {
    log(`SIT OUT ${feature.name}`);
    state.index++;
    save();
    state.index--;
    continue;
  }
  const result = NodeChildProcess.spawnSync(
    "git",
    [
      "-c",
      "gc.auto=0",
      "-c",
      "maintenance.auto=false",
      "-c",
      "rerere.enabled=false",
      "-c",
      "core.hooksPath=/dev/null",
      "cherry-pick",
      feature.sha,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    state.conflicted = true;
    save();
    log(
      `CONFLICT ${feature.name}: ${git("diff", "--name-only", "--diff-filter=U") || result.stderr}`,
    );
    throw new Error(
      `Stopped at ${feature.name}; resolve and stage, then --continue; or --continue --skip=${feature.name}`,
    );
  }
  state.head = git("rev-parse", "HEAD");
  log(`FEATURE clean ${feature.name} ${feature.sha}`);
  state.index++;
  save();
  state.index--;
}
state.head = git("rev-parse", "HEAD");
save();
log(
  `DONE ${state.branch} ${state.head}; ${((Date.now() - state.started) / 1000).toFixed(3)} seconds`,
);
