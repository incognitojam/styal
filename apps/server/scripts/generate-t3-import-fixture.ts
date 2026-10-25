#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off globalTimers:off globalFetch:off - standalone generator with no workspace imports.
/**
 * Generates the T3 Code data directory the import end-to-end test reads, by driving a T3 Code or
 * styal checkout's own server over its APIs so every stored row comes from that server.
 * `--root` becomes part of the stored paths. Only Node built-ins are imported so the script
 * runs against any checkout.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

const STYAL_ROOT = NodePath.resolve(import.meta.dirname, "../../..");
const FAKE_CODEX = NodePath.join(STYAL_ROOT, "apps/server/scripts/fake-codex.ts");
const MODEL_SELECTION = { instanceId: "codex", model: "fake-codex" };
// A 1x1 transparent PNG.
const PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const SCENARIO = {
  turns: [
    {
      match: "summarize the readme",
      steps: [
        { type: "reasoning", text: "Reading the README first." },
        { type: "command", command: "cat README.md", output: "# Demo\n", exitCode: 0 },
        { type: "message", text: "The README has a single **Demo** heading." },
      ],
    },
    {
      match: "add a changelog",
      steps: [
        { type: "command", command: "git status --short", output: "", exitCode: 0 },
        {
          type: "writeFile",
          path: "CHANGELOG.md",
          content: "# Changelog\n\n- Added the demo readme.\n",
        },
        { type: "message", text: "Added `CHANGELOG.md` with one entry." },
      ],
    },
    {
      match: "describe the screenshot",
      steps: [{ type: "message", text: "The screenshot is a single transparent pixel." }],
    },
    {
      match: "update the note in the worktree",
      steps: [
        { type: "writeFile", path: "notes.md", content: "Worktree note.\n" },
        { type: "message", text: "Wrote `notes.md` on the feature branch." },
      ],
    },
    {
      match: "trigger a failure",
      steps: [{ type: "message", text: "Starting the risky step." }],
      error: "Simulated provider failure.",
    },
  ],
};

const SETTINGS = {
  defaultThreadEnvMode: "local",
  newWorktreesStartFromOrigin: false,
  responseStreamingMode: "paragraph",
  enableProviderUpdateChecks: false,
  enableAgentBrowserAccess: false,
  addProjectBaseDirectory: "/workspace/fixture/projects",
};

/** Tables with credentials or per-server identity; the importer never reads them. */
const EXCLUDED_TABLE_PREFIXES = ["auth_"];

interface Args {
  readonly server: string;
  readonly out: string;
  readonly root: string;
}

function parseArgs(argv: ReadonlyArray<string>): Args {
  const value = (flag: string) => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  const server = value("--server");
  const out = value("--out");
  if (!server || !out) {
    process.stderr.write(
      "usage: generate-t3-import-fixture.ts --server <checkout> --out <dir> [--root <dir>]\n",
    );
    process.exit(2);
  }
  return {
    server: NodePath.resolve(server),
    out: NodePath.resolve(out),
    root: NodePath.resolve(
      value("--root") ?? NodePath.join(STYAL_ROOT, ".scratch/upstream-v2-import-fixture-runtime"),
    ),
  };
}

function git(cwd: string, ...args: ReadonlyArray<string>): string {
  return NodeChildProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
    },
  }).trim();
}

function createRepository(path: string): void {
  NodeFS.mkdirSync(path, { recursive: true });
  git(path, "init", "-q", "-b", "main");
  NodeFS.writeFileSync(NodePath.join(path, "README.md"), "# Demo\n");
  git(path, "add", "README.md");
  git(path, "commit", "-q", "-m", "Initial commit");
}

function serverEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(T3CODE_|T3_|STYAL_|VITE_)/.test(key) || key === "PORT") delete env[key];
  }
  // Checkpoints commit to the workspaces; CI runners have no git identity.
  return {
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.com",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.com",
    ...env,
  };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address !== null
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `check` until it returns a value, failing after `timeoutMs`. */
async function waitFor<T>(
  description: string,
  check: () => Promise<T | undefined>,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check().catch(() => undefined);
    if (result !== undefined) return result;
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

class Api {
  private readonly origin: string;
  private readonly token: string;
  private socket: WebSocket | null = null;
  private nextRequestId = 0;
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  constructor(origin: string, token: string) {
    this.origin = origin;
    this.token = token;
  }

  async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`${this.origin}${path}`, {
      method,
      signal: AbortSignal.timeout(30_000),
      headers: {
        authorization: `Bearer ${this.token}`,
        "x-t3-orchestration-protocol": "2",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path} failed (${response.status}): ${text}`);
    return text.length === 0 ? null : JSON.parse(text);
  }

  async connect(): Promise<void> {
    const { ticket } = (await this.request("POST", "/api/auth/websocket-ticket")) as {
      ticket: string;
    };
    const socket = new WebSocket(
      `${this.origin.replace(/^http/, "ws")}/ws?orchestrationProtocol=2&wsTicket=${encodeURIComponent(ticket)}`,
    );
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      const messages = JSON.parse(String(event.data));
      for (const message of Array.isArray(messages) ? messages : [messages]) {
        if (message._tag === "Ping") {
          socket.send(JSON.stringify({ _tag: "Pong" }));
          continue;
        }
        if (message._tag !== "Exit") continue;
        const pending = this.pending.get(String(message.requestId));
        if (!pending) continue;
        this.pending.delete(String(message.requestId));
        if (message.exit._tag === "Success") pending.resolve(message.exit.value);
        else pending.reject(new Error(JSON.stringify(message.exit)));
      }
    });
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener(
        "error",
        () => reject(new Error("Fixture websocket connection failed")),
        { once: true },
      );
    });
    socket.addEventListener("close", () => {
      for (const pending of this.pending.values())
        pending.reject(new Error("Fixture websocket closed"));
      this.pending.clear();
    });
  }

  rpc(tag: string, payload: unknown): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("Fixture websocket is not open"));
    const id = String(++this.nextRequestId);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      socket.send(
        JSON.stringify({
          _tag: "Request",
          id,
          tag,
          payload,
          headers: [["x-t3-orchestration-protocol", "2"]],
        }),
      );
    });
  }

  close(): void {
    this.socket?.close();
  }

  dispatch(command: Record<string, unknown>): Promise<unknown> {
    return this.rpc(
      String(command.type).startsWith("project.")
        ? "projects.mutate"
        : "orchestration.dispatchCommand",
      command,
    );
  }

  async thread(threadId: string): Promise<ThreadDetail> {
    const detail = (await this.request("GET", `/api/orchestration/threads/${threadId}`)) as {
      projection: ThreadDetail;
    };
    return detail.projection;
  }
}

interface ThreadDetail {
  readonly runs: ReadonlyArray<{
    readonly id: string;
    readonly status: string;
    readonly checkpointId: string | null;
  }>;
  readonly checkpoints: ReadonlyArray<{ readonly id: string }>;
}

let commandCount = 0;
const commandId = (label: string) => `fixture-${label}-${++commandCount}`;
const now = () => new Date().toISOString();

async function createProject(api: Api, projectId: string, title: string, workspaceRoot: string) {
  await api.dispatch({
    type: "project.create",
    commandId: commandId("project"),
    projectId,
    title,
    workspaceRoot,
    createdAt: now(),
  });
}

async function createThread(
  api: Api,
  input: {
    readonly threadId: string;
    readonly projectId: string;
    readonly title: string;
    readonly branch?: string;
    readonly worktreePath?: string;
  },
) {
  await api.dispatch({
    type: "thread.create",
    commandId: commandId("thread"),
    threadId: input.threadId,
    projectId: input.projectId,
    title: input.title,
    createdBy: "user",
    creationSource: "server",
    modelSelection: MODEL_SELECTION,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: input.branch ?? null,
    worktreePath: input.worktreePath ?? null,
    createdAt: now(),
  });
}

/** Waits for terminal run state and, for completed runs, its persisted checkpoint. */
async function sendTurn(
  api: Api,
  threadId: string,
  text: string,
  attachments: ReadonlyArray<Record<string, unknown>> = [],
) {
  const before = (await api.thread(threadId)).runs.at(-1)?.id;
  const messageId = commandId("message");
  const persisted =
    attachments.length === 0
      ? []
      : (
          (await api.rpc("assets.persistChatAttachments", {
            threadId,
            messageId,
            attachments,
          })) as { attachments: ReadonlyArray<Record<string, unknown>> }
        ).attachments;
  await api.dispatch({
    type: "message.dispatch",
    commandId: commandId("turn"),
    threadId,
    messageId,
    text,
    attachments: persisted,
    modelSelection: MODEL_SELECTION,
    createdBy: "user",
    creationSource: "server",
    dispatchMode: { type: "start_immediately" },
  });
  await waitFor(`the run in ${threadId} to settle`, async () => {
    const projection = await api.thread(threadId);
    const run = projection.runs.at(-1);
    return run &&
      run.id !== before &&
      ["completed", "failed", "interrupted", "cancelled"].includes(run.status) &&
      (run.status !== "completed" ||
        (run.checkpointId !== null &&
          projection.checkpoints.some((checkpoint) => checkpoint.id === run.checkpointId)))
      ? run.id
      : undefined;
  });
}

async function runScenario(api: Api, root: string) {
  const alpha = NodePath.join(root, "workspaces/alpha");
  const beta = NodePath.join(root, "workspaces/beta");
  const worktree = NodePath.join(root, "worktrees/alpha-feature");

  await createProject(api, "project-alpha", "Alpha", alpha);
  await createProject(api, "project-beta", "Beta", beta);

  await createThread(api, {
    threadId: "thread-completed",
    projectId: "project-alpha",
    title: "Completed work",
  });
  await sendTurn(api, "thread-completed", "Please summarize the readme.");
  await sendTurn(api, "thread-completed", "Now add a changelog entry.");
  await sendTurn(api, "thread-completed", "Please describe the screenshot.", [
    {
      type: "image",
      name: "pixel.png",
      mimeType: "image/png",
      sizeBytes: Buffer.from(PIXEL_PNG, "base64").length,
      dataUrl: `data:image/png;base64,${PIXEL_PNG}`,
    },
  ]);

  await createThread(api, {
    threadId: "thread-settled",
    projectId: "project-alpha",
    title: "Settled work",
  });
  await sendTurn(api, "thread-settled", "Please summarize the readme.");
  await api.dispatch({
    type: "thread.settle",
    commandId: commandId("settle"),
    threadId: "thread-settled",
  });

  await createThread(api, {
    threadId: "thread-unsettled",
    projectId: "project-alpha",
    title: "Reopened work",
  });
  await sendTurn(api, "thread-unsettled", "Please summarize the readme.");
  await api.dispatch({
    type: "thread.settle",
    commandId: commandId("settle"),
    threadId: "thread-unsettled",
  });
  await api.dispatch({
    type: "thread.unsettle",
    commandId: commandId("unsettle"),
    threadId: "thread-unsettled",
    reason: "user",
  });

  await createThread(api, {
    threadId: "thread-archived",
    projectId: "project-alpha",
    title: "Archived work",
  });
  await sendTurn(api, "thread-archived", "Please summarize the readme.");
  // The thread detail endpoint does not serve archived threads.
  const archivedDetails = { "thread-archived": await api.thread("thread-archived") };
  await api.dispatch({
    type: "thread.archive",
    commandId: commandId("archive"),
    threadId: "thread-archived",
  });

  await createThread(api, {
    threadId: "thread-deleted",
    projectId: "project-alpha",
    title: "Deleted work",
  });
  await sendTurn(api, "thread-deleted", "Please summarize the readme.");
  await api.dispatch({
    type: "thread.delete",
    commandId: commandId("delete"),
    threadId: "thread-deleted",
  });

  await createThread(api, {
    threadId: "thread-failed",
    projectId: "project-alpha",
    title: "Failed work",
  });
  await sendTurn(api, "thread-failed", "Please trigger a failure.");

  await createThread(api, {
    threadId: "thread-worktree",
    projectId: "project-alpha",
    title: "Worktree work",
    branch: "feature/import-demo",
    worktreePath: worktree,
  });
  await sendTurn(api, "thread-worktree", "Please update the note in the worktree.");

  await createThread(api, {
    threadId: "thread-empty",
    projectId: "project-alpha",
    title: "Empty thread",
  });

  await createThread(api, {
    threadId: "thread-beta",
    projectId: "project-beta",
    title: "Beta work",
  });
  await sendTurn(api, "thread-beta", "Please summarize the readme.");

  return {
    importedThreadIds: [
      "thread-completed",
      "thread-settled",
      "thread-unsettled",
      "thread-archived",
      "thread-failed",
      "thread-worktree",
      "thread-empty",
      "thread-beta",
    ],
    deletedThreadIds: ["thread-deleted"],
    archivedDetails,
  };
}

function sqlValue(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString("hex")}'`;
  return `'${String(value).replaceAll("'", "''")}'`;
}

/** Writes the database as SQL that `node:sqlite` can load with `exec`. */
function dumpDatabase(databasePath: string, outputPath: string): void {
  const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  const objects = database
    .prepare(
      "SELECT type, name, tbl_name AS tableName, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type = 'table' DESC, name",
    )
    .all()
    .map((row) => ({
      type: String(row.type),
      name: String(row.name),
      tableName: String(row.tableName),
      sql: String(row.sql),
    }));
  const included = objects.filter(
    (object) => !EXCLUDED_TABLE_PREFIXES.some((prefix) => object.tableName.startsWith(prefix)),
  );
  const lines = ["PRAGMA foreign_keys=OFF;", "BEGIN;"];
  for (const table of included.filter((object) => object.type === "table")) {
    lines.push(`${table.sql};`);
    const statement = database.prepare(`SELECT * FROM "${table.name}"`);
    statement.setReadBigInts(true);
    for (const row of statement.all() as ReadonlyArray<Record<string, unknown>>) {
      const columns = Object.keys(row)
        .map((column) => `"${column}"`)
        .join(", ");
      const values = Object.values(row).map(sqlValue).join(", ");
      lines.push(`INSERT INTO "${table.name}" (${columns}) VALUES (${values});`);
    }
  }
  const sequences = database
    .prepare("SELECT name, seq FROM sqlite_sequence")
    .all()
    .map((row) => ({ name: String(row.name), seq: Number(row.seq) }));
  for (const sequence of sequences.filter((row) =>
    included.some((object) => object.type === "table" && object.name === row.name),
  )) {
    lines.push(
      `INSERT INTO sqlite_sequence (name, seq) VALUES (${sqlValue(sequence.name)}, ${sequence.seq});`,
    );
  }
  for (const object of included.filter((candidate) => candidate.type !== "table")) {
    lines.push(`${object.sql};`);
  }
  lines.push("COMMIT;", "");
  NodeFS.writeFileSync(outputPath, lines.join("\n"), "utf8");
  database.close();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const serverBin = NodePath.join(args.server, "apps/server/src/bin.ts");
  if (!NodeFS.existsSync(serverBin)) throw new Error(`No server entry point at ${serverBin}`);

  NodeFS.rmSync(args.root, { recursive: true, force: true });
  const home = NodePath.join(args.root, "home");
  const alpha = NodePath.join(args.root, "workspaces/alpha");
  createRepository(alpha);
  createRepository(NodePath.join(args.root, "workspaces/beta"));
  git(
    alpha,
    "worktree",
    "add",
    "-q",
    "-b",
    "feature/import-demo",
    NodePath.join(args.root, "worktrees/alpha-feature"),
  );

  const scenarioPath = NodePath.join(args.root, "scenario.json");
  NodeFS.writeFileSync(scenarioPath, JSON.stringify(SCENARIO, null, 2));
  const launcher = NodeChildProcess.execFileSync(
    process.execPath,
    [FAKE_CODEX, "install", NodePath.join(args.root, "bin"), "--scenario", scenarioPath],
    { encoding: "utf8" },
  ).trim();

  NodeFS.mkdirSync(NodePath.join(home, "userdata"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(home, "userdata/settings.json"),
    JSON.stringify(
      {
        ...SETTINGS,
        providers: {
          codex: { binaryPath: launcher },
          claudeAgent: { enabled: false },
          cursor: { enabled: false },
          grok: { enabled: false },
          opencode: { enabled: false },
          antigravity: { enabled: false },
        },
      },
      null,
      2,
    ),
  );

  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const log = NodeFS.openSync(NodePath.join(args.root, "server.log"), "w");
  const server = NodeChildProcess.spawn(
    process.execPath,
    [serverBin, "serve", "--base-dir", home, "--port", String(port)],
    { cwd: args.root, env: serverEnvironment(), stdio: ["ignore", log, log] },
  );
  const exited = new Promise<number | null>((resolve) => server.once("exit", resolve));

  try {
    await waitFor("the server to listen", async () => {
      // A connection accepted during startup can go unanswered, so bound each attempt.
      const response = await fetch(`${origin}/.well-known/t3/environment`, {
        signal: AbortSignal.timeout(2_000),
      });
      return response.ok ? true : undefined;
    });
    const token = NodeChildProcess.execFileSync(
      process.execPath,
      [serverBin, "auth", "session", "issue", "--base-dir", home, "--ttl", "1h", "--token-only"],
      { encoding: "utf8", env: serverEnvironment() },
    )
      .trim()
      .split("\n")
      .at(-1)!;
    const api = new Api(origin, token);
    await api.connect();
    const expected = await runScenario(api, args.root);
    // The snapshot lists threads without their messages, activities, or checkpoints.
    const snapshot = (await api.request("GET", "/api/orchestration/shell")) as {
      readonly threads: ReadonlyArray<{ readonly id: string }>;
    };
    const { archivedDetails, ...manifestScenario } = expected;
    const threads: Record<string, unknown> = { ...archivedDetails };
    for (const threadId of expected.importedThreadIds) {
      threads[threadId] ??= await api.thread(threadId);
    }
    const view = { snapshot, threads };

    api.close();
    server.kill("SIGTERM");
    await exited;

    NodeFS.rmSync(args.out, { recursive: true, force: true });
    NodeFS.mkdirSync(args.out, { recursive: true });
    dumpDatabase(
      NodePath.join(home, "userdata/statev2.sqlite"),
      NodePath.join(args.out, "state.sql"),
    );
    NodeFS.cpSync(
      NodePath.join(home, "userdata/attachments"),
      NodePath.join(args.out, "attachments"),
      {
        recursive: true,
      },
    );
    NodeFS.copyFileSync(
      NodePath.join(home, "userdata/settings.json"),
      NodePath.join(args.out, "settings.json"),
    );
    NodeFS.writeFileSync(
      NodePath.join(args.out, "t3-view.json"),
      `${JSON.stringify(view, null, 2)}\n`,
    );
    NodeFS.writeFileSync(
      NodePath.join(args.out, "manifest.json"),
      `${JSON.stringify(
        {
          orchestrationVersion: 2,
          databaseFilename: "statev2.sqlite",
          serverRevision: git(args.server, "rev-parse", "HEAD"),
          generatedAt: now(),
          root: args.root,
          ...manifestScenario,
          settings: SETTINGS,
        },
        null,
        2,
      )}\n`,
    );
    process.stdout.write(`Wrote ${args.out}\n`);
  } finally {
    if (server.exitCode === null) {
      server.kill("SIGTERM");
      await exited;
    }
  }
}

await main();
