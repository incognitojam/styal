// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off globalTimers:off - e2e harness runs plain Node outside any Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { hasTestFailed, markFailed } from "./failures.ts";

const REPO_ROOT = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../..",
);
const SERVER_BIN = NodePath.join(REPO_ROOT, "apps/server/src/bin.ts");
const WEB_DIST_INDEX = NodePath.join(REPO_ROOT, "apps/web/dist/index.html");
const FAKE_CODEX = NodePath.join(REPO_ROOT, "apps/server/scripts/fake-codex.ts");
const FAKE_GH = NodePath.join(REPO_ROOT, "e2e/fixtures/fake-gh.ts");

export const PROJECT_NAME = "demo-app";

/** A GitHub issue in `gh issue view --json number,title,state,url,body,author,comments` shape. */
export interface FakeGitHubIssue {
  readonly number: number;
  readonly title: string;
  readonly state: "OPEN" | "CLOSED";
  readonly url: string;
  readonly body: string;
  readonly author: { readonly login: string };
  readonly comments: ReadonlyArray<{
    readonly author: { readonly login: string };
    readonly body: string;
  }>;
}

export interface EnvironmentOptions {
  /** fake-codex scenario; see apps/server/scripts/fake-codex.ts. Without one, replies echo the prompt. */
  readonly scenario?: { readonly turns: ReadonlyArray<unknown>; readonly stepDelayMs?: number };
  readonly issues?: ReadonlyArray<FakeGitHubIssue>;
}

/** One provider turn as fake-codex received it. */
export interface CodexTurnRequest {
  readonly threadId: string;
  readonly input: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
}

export interface Environment {
  /**
   * Temporary directory holding this environment's state, logs, and failure screenshots. It is
   * kept when a test fails or `E2E_KEEP_STATE` is set.
   */
  readonly root: string;
  readonly origin: string;
  /** One-time pairing URL printed at startup. */
  readonly pairingUrl: string;
  readonly projectDir: string;
  /** Turns fake-codex has started, oldest first. */
  readonly codexTurns: () => ReadonlyArray<CodexTurnRequest>;
  /** Argument lists of every `gh` call, oldest first. */
  readonly ghCalls: () => ReadonlyArray<ReadonlyArray<string>>;
  readonly serverLog: () => string;
  readonly stop: () => Promise<void>;
}

/**
 * Starts an isolated server for one test file: a fresh home and base dir, a git project with
 * a GitHub remote, Codex backed by fake-codex with every other provider off, and a fake `gh`.
 * The server serves the prebuilt web bundle on its own port.
 *
 * The server runs with an allowlisted environment and a throwaway HOME, so it cannot read
 * the developer's provider credentials, `gh` login, or git config. Its login shell reads the
 * throwaway HOME's profile, which puts the fake `gh` ahead of any real one on PATH.
 */
export async function startEnvironment(options: EnvironmentOptions = {}): Promise<Environment> {
  if (!NodeFS.existsSync(WEB_DIST_INDEX)) {
    throw new Error("apps/web/dist is missing. Build it first: vp run --filter @t3tools/web build");
  }
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "styal-e2e-"));
  const home = NodePath.join(root, "home");
  const baseDir = NodePath.join(root, "styal");
  const bin = NodePath.join(root, "bin");
  const projectDir = NodePath.join(root, "workspace", PROJECT_NAME);
  const codexRequestLog = NodePath.join(root, "codex-requests.jsonl");
  const ghCallLog = NodePath.join(root, "gh-calls.jsonl");
  const serverLogPath = NodePath.join(root, "server.log");
  for (const directory of [home, bin, projectDir, NodePath.join(baseDir, "userdata")]) {
    NodeFS.mkdirSync(directory, { recursive: true });
  }

  NodeFS.writeFileSync(
    NodePath.join(home, ".gitconfig"),
    "[user]\n\tname = Styal E2E\n\temail = e2e@example.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n",
  );
  const profile = `export PATH=${shellQuote(bin)}:"$PATH"\n`;
  NodeFS.writeFileSync(NodePath.join(home, ".profile"), profile);
  NodeFS.writeFileSync(NodePath.join(home, ".bash_profile"), profile);

  const issuesPath = NodePath.join(root, "gh-issues.json");
  NodeFS.writeFileSync(issuesPath, JSON.stringify(options.issues ?? []));
  writeLauncher(NodePath.join(bin, "gh"), FAKE_GH, {
    E2E_GH_ISSUES: issuesPath,
    E2E_GH_CALL_LOG: ghCallLog,
  });

  const scenarioPath = NodePath.join(root, "codex-scenario.json");
  NodeFS.writeFileSync(scenarioPath, JSON.stringify(options.scenario ?? { turns: [] }));
  const codexLauncher = NodeChildProcess.execFileSync(
    process.execPath,
    [FAKE_CODEX, "install", bin, "--scenario", scenarioPath, "--request-log", codexRequestLog],
    { encoding: "utf8" },
  ).trim();

  NodeFS.writeFileSync(
    NodePath.join(baseDir, "userdata/settings.json"),
    JSON.stringify({
      defaultThreadEnvMode: "local",
      enableProviderUpdateChecks: false,
      enableAgentBrowserAccess: false,
      providers: {
        codex: { binaryPath: codexLauncher },
        claudeAgent: { enabled: false },
        cursor: { enabled: false },
        grok: { enabled: false },
        opencode: { enabled: false },
        antigravity: { enabled: false },
      },
    }),
  );

  const env = isolatedEnv(home, bin);
  const git = (...args: ReadonlyArray<string>) =>
    NodeChildProcess.execFileSync("git", args, { cwd: projectDir, env, stdio: "ignore" });
  git("init", "-q");
  git("remote", "add", "origin", `https://github.com/e2e-org/${PROJECT_NAME}.git`);
  NodeFS.writeFileSync(NodePath.join(projectDir, "README.md"), `# ${PROJECT_NAME}\n`);
  git("add", "README.md");
  git("commit", "-q", "-m", "Initial commit");

  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const serverLog = NodeFS.openSync(serverLogPath, "w");
  const server = NodeChildProcess.spawn(
    process.execPath,
    [
      SERVER_BIN,
      // `serve` never bootstraps a project from its cwd; `start` does, and prints the same URL.
      "start",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--base-dir",
      baseDir,
      "--no-browser",
      "--auto-bootstrap-project-from-cwd",
    ],
    { cwd: projectDir, env, stdio: ["ignore", serverLog, serverLog] },
  );
  const exited = new Promise<void>((resolve) => server.once("exit", () => resolve()));
  const readServerLog = () => NodeFS.readFileSync(serverLogPath, "utf8");

  const stop = async () => {
    if (server.exitCode === null && server.signalCode === null) {
      server.kill("SIGTERM");
      const killTimer = setTimeout(() => server.kill("SIGKILL"), 10_000);
      await exited;
      clearTimeout(killTimer);
    }
    NodeFS.closeSync(serverLog);
    if (process.env.E2E_KEEP_STATE || hasTestFailed()) {
      process.stderr.write(`e2e state kept at ${root}\n`);
    } else {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  };

  let pairingUrl: string;
  try {
    pairingUrl = await waitFor("the server's pairing URL", () => {
      if (server.exitCode !== null) throw new Error(`The server exited:\n${readServerLog()}`);
      return /(?:Pairing URL|pairingUrl): (\S+)/.exec(readServerLog())?.[1];
    });
  } catch (error) {
    markFailed();
    await stop();
    throw error;
  }

  return {
    root,
    origin,
    pairingUrl,
    projectDir,
    codexTurns: () => readJsonLines<CodexTurnRequest>(codexRequestLog),
    ghCalls: () => readJsonLines<ReadonlyArray<string>>(ghCallLog),
    serverLog: readServerLog,
    stop,
  };
}

/** Host variables a server needs that carry no identity or credentials. */
const INHERITED_VARIABLES = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "USER", "TMPDIR"];

function isolatedEnv(home: string, bin: string): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    INHERITED_VARIABLES.flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
  return {
    ...inherited,
    PATH: `${bin}${NodePath.delimiter}${process.env.PATH ?? ""}`,
    HOME: home,
    SHELL: NodeFS.existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh",
    XDG_CONFIG_HOME: NodePath.join(home, ".config"),
    XDG_DATA_HOME: NodePath.join(home, ".local/share"),
    XDG_STATE_HOME: NodePath.join(home, ".local/state"),
    XDG_CACHE_HOME: NodePath.join(home, ".cache"),
    GIT_CONFIG_NOSYSTEM: "1",
    T3CODE_TELEMETRY_ENABLED: "0",
  };
}

function writeLauncher(path: string, script: string, env: Record<string, string>): void {
  NodeFS.writeFileSync(
    path,
    [
      "#!/bin/sh",
      ...Object.entries(env).map(([name, value]) => `export ${name}=${shellQuote(value)}`),
      `exec ${shellQuote(process.execPath)} ${shellQuote(script)} "$@"`,
      "",
    ].join("\n"),
  );
  NodeFS.chmodSync(path, 0o755);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function readJsonLines<T>(path: string): ReadonlyArray<T> {
  if (!NodeFS.existsSync(path)) return [];
  return NodeFS.readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = NodeNet.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === "object" && address !== null
          ? resolve(address.port)
          : reject(new Error("No port was assigned.")),
      );
    });
  });
}

async function waitFor<T>(description: string, read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}.`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
