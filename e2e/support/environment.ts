// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off globalTimers:off - e2e harness runs plain Node outside any Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { markFailed } from "./failures.ts";
import { ownProcess, stateResources } from "./resources.ts";
import {
  type FakeGitHubApiRequest,
  type FakeGitHubPullRequest,
  type FakeGitHubWorkflowRun,
  startFakeGitHubApi,
} from "./fake-github-api.ts";

const REPO_ROOT = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../..",
);
const SERVER_BIN = NodePath.join(REPO_ROOT, "apps/server/src/bin.ts");
const WEB_DIST_INDEX = NodePath.join(REPO_ROOT, "apps/web/dist/index.html");
const FAKE_CODEX = NodePath.join(REPO_ROOT, "apps/server/scripts/fake-codex.ts");
const FAKE_GH = NodePath.join(REPO_ROOT, "e2e/fixtures/fake-gh.ts");

export const PROJECT_NAME = "demo-app";

/** A GitHub issue the fake GitHub API serves to the issue list and issue reads. */
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
  readonly pullRequests?: ReadonlyArray<FakeGitHubPullRequest>;
  readonly workflowRuns?: ReadonlyArray<FakeGitHubWorkflowRun>;
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
  /**
   * Creates a folder with a README next to `projectDir`, ready to add as a project. It is a git
   * repository with one commit unless `git` is false; a plain folder skips turn checkpoints.
   */
  readonly createProject: (name: string, options?: { readonly git?: boolean }) => string;
  /** Turns fake-codex has started, oldest first. */
  readonly codexTurns: () => ReadonlyArray<CodexTurnRequest>;
  /** Requests the server sent to fake-codex, including native background-terminal control. */
  readonly codexRpcRequests: () => ReadonlyArray<{
    readonly method: string;
    readonly params: Readonly<Record<string, unknown>>;
  }>;
  /** Argument lists of every `gh` call, oldest first. */
  readonly ghCalls: () => ReadonlyArray<ReadonlyArray<string>>;
  /** Every request the server sent to the fake GitHub API, oldest first. */
  readonly gitHubApiRequests: () => ReadonlyArray<FakeGitHubApiRequest>;
  readonly serverLog: () => string;
  /** Restarts the server on the same port with its persisted state, keeping the fake APIs. */
  readonly restart: () => Promise<void>;
  readonly stop: () => Promise<void>;
}

/**
 * The server runs with an allowlisted environment and a throwaway HOME, so it cannot read the
 * developer's provider credentials, `gh` login, or git config. Its login shell reads the
 * throwaway HOME's profile, which puts the fake `gh` ahead of any real one on PATH.
 */
export async function startEnvironment(options: EnvironmentOptions = {}): Promise<Environment> {
  if (!NodeFS.existsSync(WEB_DIST_INDEX)) {
    throw new Error("apps/web/dist is missing. Build it first: vp run --filter @t3tools/web build");
  }
  const state = stateResources("styal-e2e-");
  try {
    return await setupEnvironment(options, state);
  } catch (error) {
    markFailed();
    await state.stop();
    throw error;
  }
}

async function setupEnvironment(
  options: EnvironmentOptions,
  { root, resources, stop }: ReturnType<typeof stateResources>,
): Promise<Environment> {
  const home = NodePath.join(root, "home");
  const baseDir = NodePath.join(root, "styal");
  const bin = NodePath.join(root, "bin");
  const projectDir = NodePath.join(root, "workspace", PROJECT_NAME);
  const codexRequestLog = NodePath.join(root, "codex-requests.jsonl");
  const codexRpcLog = NodePath.join(root, "codex-rpc.jsonl");
  const ghCallLog = NodePath.join(root, "gh-calls.jsonl");
  const serverLogPath = NodePath.join(root, "server.log");
  for (const directory of [home, bin, NodePath.join(baseDir, "userdata")]) {
    NodeFS.mkdirSync(directory, { recursive: true });
  }

  NodeFS.writeFileSync(
    NodePath.join(home, ".gitconfig"),
    "[user]\n\tname = Styal E2E\n\temail = e2e@example.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n",
  );
  const profile = `export PATH=${shellQuote(bin)}:"$PATH"\n`;
  NodeFS.writeFileSync(NodePath.join(home, ".profile"), profile);
  NodeFS.writeFileSync(NodePath.join(home, ".bash_profile"), profile);

  writeLauncher(NodePath.join(bin, "gh"), FAKE_GH, { E2E_GH_CALL_LOG: ghCallLog });
  const gitHubApi = await startFakeGitHubApi(
    options.issues ?? [],
    options.pullRequests ?? [],
    options.workflowRuns ?? [],
  );
  resources.defer(async () => {
    try {
      await gitHubApi.stop();
    } finally {
      NodeFS.writeFileSync(
        NodePath.join(root, "github-api-requests.json"),
        JSON.stringify(gitHubApi.requests(), null, 2),
      );
    }
  });

  const scenarioPath = NodePath.join(root, "codex-scenario.json");
  NodeFS.writeFileSync(scenarioPath, JSON.stringify(options.scenario ?? { turns: [] }));
  const codexLauncher = NodeChildProcess.execFileSync(
    process.execPath,
    [
      FAKE_CODEX,
      "install",
      bin,
      "--scenario",
      scenarioPath,
      "--request-log",
      codexRequestLog,
      "--rpc-log",
      codexRpcLog,
    ],
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

  const env = { ...isolatedEnv(home, bin), T3CODE_TEST_GITHUB_API_URL: gitHubApi.url };
  const createProject: Environment["createProject"] = (name, options = {}) => {
    const directory = NodePath.join(NodePath.dirname(projectDir), name);
    NodeFS.mkdirSync(directory, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(directory, "README.md"), `# ${name}\n`);
    if (options.git === false) return directory;
    const git = (...args: ReadonlyArray<string>) =>
      NodeChildProcess.execFileSync("git", args, { cwd: directory, env, stdio: "ignore" });
    git("init", "-q");
    git("remote", "add", "origin", `https://github.com/e2e-org/${name}.git`);
    git("add", "README.md");
    git("commit", "-q", "-m", "Initial commit");
    return directory;
  };
  createProject(PROJECT_NAME);

  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const serverLog = NodeFS.openSync(serverLogPath, "w");
  resources.defer(() => NodeFS.closeSync(serverLog));
  const launchServer = () =>
    NodeChildProcess.spawn(
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
  let server = launchServer();
  let assertRunning = ownProcess(resources, server, 10_000);
  const readServerLog = () => NodeFS.readFileSync(serverLogPath, "utf8");
  const waitForStartup = (logOffset = 0) =>
    waitFor(
      "the server's pairing URL",
      () => {
        assertRunning();
        return /(?:Pairing URL|pairingUrl): (\S+)/.exec(readServerLog().slice(logOffset))?.[1];
      },
      readServerLog,
    );
  const pairingUrl = await waitForStartup();

  return {
    root,
    origin,
    pairingUrl,
    projectDir,
    createProject,
    codexTurns: () => readJsonLines<CodexTurnRequest>(codexRequestLog),
    codexRpcRequests: () => readJsonLines(codexRpcLog),
    ghCalls: () => readJsonLines<ReadonlyArray<string>>(ghCallLog),
    gitHubApiRequests: gitHubApi.requests,
    serverLog: readServerLog,
    restart: async () => {
      assertRunning();
      const closed = new Promise<void>((resolve) => server.once("close", () => resolve()));
      server.kill("SIGTERM");
      await closed;
      const logOffset = readServerLog().length;
      server = launchServer();
      assertRunning = ownProcess(resources, server, 10_000);
      await waitForStartup(logOffset);
    },
    stop,
  };
}

/** Host variables a server needs that carry no identity or credentials. */
const INHERITED_VARIABLES = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "USER", "TMPDIR"];

export function isolatedEnv(home: string, bin: string): NodeJS.ProcessEnv {
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
    // Plain-folder fixtures must not discover a repository above the isolated home.
    GIT_CEILING_DIRECTORIES: NodePath.dirname(home),
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

export function freePort(): Promise<number> {
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

export async function waitFor<T>(
  description: string,
  read: () => T | undefined,
  diagnostics?: () => string,
): Promise<T> {
  const deadline = Date.now() + 90_000;
  try {
    for (;;) {
      const value = read();
      if (value !== undefined) return value;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}.`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  } catch (error) {
    if (!diagnostics) throw error;
    throw new Error(`${String(error)}\nServer log tail:\n${diagnostics().slice(-8_000)}`, {
      cause: error,
    });
  }
}
