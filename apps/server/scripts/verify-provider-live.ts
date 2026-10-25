// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalFetch:off globalConsole:off globalConsoleInEffect:off globalDateInEffect:off preferSchemaOverJson:off - Host-side process verifier retains raw wire evidence and owns deadline timers.
/**
 * Real provider turn verifier that gates automatic provider updates in the canary. Boots a real
 * server with a fresh T3 home and drives provider turns with this process's CLI credentials.
 * Scenarios target breakages past provider releases caused, such as resume decode failures that
 * only show after a restart, unhandled approvals, and rollbacks the provider silently ignores.
 */
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Socket } from "effect/socket";
import { RpcClient, RpcSerialization } from "effect/rpc";
import {
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_PROTOCOL_HEADER,
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WsRpcGroup,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  type OrchestrationV2ThreadProjection,
  type RuntimeMode,
  type ServerProvider,
} from "@t3tools/contracts";

const SCENARIOS = [
  "provider",
  "tool-turn",
  "server-env",
  "checkpoint",
  "resume",
  "interrupt",
  "approval",
  "auto",
  "rewind",
  "native-subagent",
  "cold-resume",
  "clean-projection",
] as const;
type ScenarioName = (typeof SCENARIOS)[number];

const { values } = NodeUtil.parseArgs({
  options: {
    provider: { type: "string" },
    model: { type: "string" },
    timeout: { type: "string", default: "180" },
    "expect-version": { type: "string" },
    scenario: { type: "string", default: "all" },
  },
});
const provider = values.provider;
const model = values.model;
NodeAssert.ok(provider && model, "--provider and --model are required");
const scenarioTimeoutMs = Number(values.timeout) * 1000;
NodeAssert.ok(
  Number.isFinite(scenarioTimeoutMs) && scenarioTimeoutMs > 0,
  "timeout must be positive seconds",
);
const expectedVersion = values["expect-version"];
NodeAssert.ok(
  expectedVersion === undefined || /^\d+\.\d+\.\d+$/.test(expectedVersion),
  "--expect-version must be x.y.z",
);
const requested =
  values.scenario === "all"
    ? new Set<string>(SCENARIOS)
    : new Set(values.scenario.split(",").map((name) => name.trim()));
for (const name of requested) {
  NodeAssert.ok(
    (SCENARIOS as ReadonlyArray<string>).includes(name),
    `Unknown scenario ${name}. Use a comma-separated list of: ${SCENARIOS.join(", ")}`,
  );
}
const selected = (name: ScenarioName) => name === "provider" || requested.has(name);
// Checkpoint, resume and cold resume continue the tool turn's thread.
const runToolTurn =
  selected("tool-turn") || selected("checkpoint") || selected("resume") || selected("cold-resume");

/**
 * Prompt fragment naming each driver's own subagent tool. A driver without an
 * entry skips the native subagent scenario.
 */
const NATIVE_SUBAGENT_TOOL: Readonly<Record<string, string>> = {
  claudeAgent: "your Agent tool (the Task tool)",
  // Codex's multi_agent feature is stable and on by default.
  codex: "your spawn_agent tool, then wait for that agent to finish",
  opencode: "your task tool with the general subagent",
};

/**
 * Server log lines at WARN or ERROR that are expected during a healthy run.
 * Each entry needs a comment naming why it is benign.
 */
const ALLOWED_LOG_WARNINGS: ReadonlyArray<RegExp> = [];

const BUILT_IN_PROVIDERS = [
  "codex",
  "claudeAgent",
  "cursor",
  "grok",
  "pi",
  "opencode",
  "antigravity",
] as const;
const TERMINAL_SUBAGENT_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);
const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

const root = NodePath.resolve(import.meta.dirname, "../../..");
const evidence = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "styal-provider-live-"));
const home = NodePath.join(evidence, "home");
const project = NodePath.join(evidence, "project");
const serverLogPath = NodePath.join(evidence, "server.log");
NodeFS.mkdirSync(project);
NodeFS.mkdirSync(NodePath.join(home, "userdata"), { recursive: true });
NodeChildProcess.execFileSync("git", ["init", "-q", project]);
NodeFS.writeFileSync(NodePath.join(project, "README.md"), "# Provider verification\n");
NodeChildProcess.execFileSync("git", ["-C", project, "add", "README.md"]);
NodeChildProcess.execFileSync("git", [
  "-C",
  project,
  "-c",
  "user.name=Verifier",
  "-c",
  "user.email=verifier@localhost",
  "commit",
  "-qm",
  "initial",
]);
console.log(`Evidence: ${evidence}`);
const projectBranch = NodeChildProcess.execFileSync(
  "git",
  ["-C", project, "rev-parse", "--abbrev-ref", "HEAD"],
  { encoding: "utf8" },
).trim();

// The server must not update providers itself while the canary pins a version.
NodeFS.writeFileSync(
  NodePath.join(home, "userdata/settings.json"),
  JSON.stringify(
    {
      defaultThreadEnvMode: "local",
      enableProviderUpdateChecks: false,
      autoUpdateProviders: false,
      enableAgentBrowserAccess: false,
      // Some providers (OpenCode) are off by default, so enable the one under test.
      providers: Object.fromEntries(
        BUILT_IN_PROVIDERS.map((key) => [key, { enabled: key === provider }]),
      ),
    },
    null,
    2,
  ),
);
NodeFS.writeFileSync(
  NodePath.join(evidence, "manifest.json"),
  JSON.stringify(
    {
      revision: NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      provider,
      model,
      expectedVersion: expectedVersion ?? null,
      scenarios: [...requested],
      startedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);

// Reserve an ephemeral port, then give it to the real server. A bind race fails
// the check; it never falls back to an existing environment.
const reservation = NodeHttp.createServer();
reservation.listen(0, "127.0.0.1");
await new Promise<void>((done) => reservation.once("listening", done));
const address = reservation.address();
NodeAssert.ok(address && typeof address !== "string");
await new Promise<void>((done) => reservation.close(() => done()));
const port = address.port;
const origin = `http://127.0.0.1:${port}`;
const bootstrap = NodeCrypto.randomUUID();

/**
 * Drops the variables that configure a styal server (`STYAL_HOME`, `T3CODE_*`,
 * `VITE_*`), so a verifier started from inside styal cannot land on the
 * caller's state directory, port, or Tailscale mapping. Provider credentials
 * such as `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` pass through.
 */
function serverEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/^(STYAL_|T3CODE_|T3_|VITE_)/i.test(key) || key === "PORT") continue;
    env[key] = value;
  }
  // The verifier never opens a browser tab. Without this, a host that blocks
  // the browser sandbox (Ubuntu 23.10+ runners) logs a warning on every start,
  // which the clean projection check reports.
  env.T3CODE_SERVER_BROWSER_SANDBOX = "0";
  // Set like a desktop-launched server has it, so the server-env scenario can
  // check that agent shells do not inherit it.
  env.T3CODE_PORT = String(port);
  return env;
}

/** Starts a server on the verifier's home; restarts reuse the same database. */
function startServer() {
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      NodePath.join(root, "apps/server/src/bin.ts"),
      "start",
      "--bootstrap-fd",
      "3",
      "--base-dir",
      home,
      "--log-level",
      "debug",
    ],
    {
      cwd: evidence,
      env: serverEnvironment(),
      detached: true,
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    },
  );
  const bootstrapPipe = child.stdio[3];
  NodeAssert.ok(bootstrapPipe && "write" in bootstrapPipe);
  bootstrapPipe.end(
    JSON.stringify({
      mode: "desktop",
      noBrowser: true,
      port,
      t3Home: home,
      host: "127.0.0.1",
      desktopBootstrapToken: bootstrap,
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
    }),
  );
  const ready = Promise.withResolvers<void>();
  let output = "";
  for (const pipe of [child.stdout, child.stderr])
    pipe?.on("data", (data: Buffer) => {
      const text = data.toString().replaceAll(bootstrap, "[REDACTED]");
      NodeFS.appendFileSync(serverLogPath, text);
      output = (output + text).slice(-8192);
      if (output.includes("startup phase: complete")) ready.resolve();
    });
  child.once("error", ready.reject);
  child.once("exit", (code) => ready.reject(new Error(`Server exited ${code}`)));
  const deadline = setTimeout(() => ready.reject(new Error("Server startup timed out")), 90_000);
  return { child, ready: ready.promise.finally(() => clearTimeout(deadline)) };
}

let server = startServer();

const abort = new AbortController();
const onSignal = () => abort.abort(new Error("Verification interrupted"));
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);

interface ScenarioResult {
  readonly name: ScenarioName;
  status: "passed" | "failed" | "skipped";
  detail: string;
  seconds: number;
}
const scenarios: Array<ScenarioResult> = SCENARIOS.map((name) => ({
  name,
  status: "skipped",
  detail: selected(name) ? "not run" : "not selected",
  seconds: 0,
}));
const scenario = (name: ScenarioName) => scenarios.find((entry) => entry.name === name)!;
let reportedVersion: string | null = null;

class ScenarioFailure extends Error {}

function fail(detail: string): never {
  throw new ScenarioFailure(detail);
}

function writeEvidence(name: string, value: unknown) {
  NodeFS.writeFileSync(NodePath.join(evidence, name), JSON.stringify(value, null, 2));
}

function runFor(projection: OrchestrationV2ThreadProjection, messageId: MessageId) {
  return projection.runs.find((run) => run.userMessageId === messageId);
}

function assistantText(projection: OrchestrationV2ThreadProjection, run: OrchestrationV2Run) {
  return projection.messages
    .filter((message) => message.role === "assistant" && message.runId === run.id)
    .map((message) => message.text)
    .join("\n");
}

function nativeThreadId(projection: OrchestrationV2ThreadProjection, run: OrchestrationV2Run) {
  return (
    projection.providerThreads.find((thread) => thread.id === run.providerThreadId)?.nativeThreadRef
      ?.nativeId ?? null
  );
}

function randomToken(prefix: string) {
  return `${prefix}-${NodeCrypto.randomBytes(6).toString("hex").toUpperCase()}`;
}

function logSize() {
  return NodeFS.existsSync(serverLogPath) ? NodeFS.statSync(serverLogPath).size : 0;
}

/** WARN and ERROR server log lines written since `offset`, minus the allowlist. */
function logWarningsSince(offset: number) {
  const text = NodeFS.readFileSync(serverLogPath).subarray(offset).toString();
  return text
    .split("\n")
    .filter((line) => /^\[[\d:.]+\] (WARN|ERROR)\b/.test(line))
    .filter((line) => !ALLOWED_LOG_WARNINGS.some((pattern) => pattern.test(line)))
    .map((line) => line.slice(0, 300));
}

// Problems found by the clean projection check, keyed by the scenario that produced them.
const offenses = new Map<string, Array<string>>();
let inspected = 0;

/**
 * Records error items, provider notices, failed runs or work, provider session
 * errors, rollback failures, stalled requests, and new server warnings. These
 * are what unhandled provider events and broken turn endings leave behind.
 */
function inspect(
  label: string,
  projection: OrchestrationV2ThreadProjection | undefined,
  logOffset: number,
) {
  inspected++;
  const found: Array<string> = [];
  if (projection) {
    const stopped = new Set(
      projection.runs
        .filter((run) => run.status === "interrupted" || run.status === "cancelled")
        .map((run) => run.id),
    );
    for (const item of projection.turnItems) {
      if (item.type === "error")
        found.push(`error item: ${item.failure.class}: ${item.failure.message}`);
      if (item.type === "system_notice") found.push(`provider notice: ${item.message}`);
    }
    for (const run of projection.runs) {
      if (run.status === "failed") found.push(`run ${run.ordinal} failed`);
    }
    for (const attempt of projection.attempts) {
      if (attempt.status === "failed" && !stopped.has(attempt.runId))
        found.push(`attempt ${attempt.id} failed`);
    }
    for (const node of projection.nodes) {
      if (node.status === "failed" && !(node.runId && stopped.has(node.runId)))
        found.push(`${node.kind} node ${node.id} failed`);
    }
    for (const session of projection.providerSessions) {
      if (session.status === "error" || session.lastError)
        found.push(`provider session error: ${session.lastError ?? session.status}`);
    }
    for (const thread of projection.providerThreads) {
      if (thread.status === "error") found.push(`provider thread ${thread.id} is in error`);
    }
    if (projection.thread.rollbackFailure)
      found.push(`rollback failed: ${projection.thread.rollbackFailure.message}`);
    if (projection.runs.every((run) => TERMINAL_RUN_STATUSES.has(run.status))) {
      for (const request of projection.runtimeRequests) {
        if (request.status === "pending")
          found.push(`${request.kind} request ${request.id} still pending`);
      }
    }
  }
  found.push(...logWarningsSince(logOffset).map((line) => `server log: ${line}`));
  if (found.length > 0) {
    offenses.set(label, [...(offenses.get(label) ?? []), ...new Set(found)]);
  }
}

const decodeTicket = Schema.decodeUnknownSync(Schema.Struct({ ticket: Schema.String }));

/** Mints a single-use WebSocket ticket and returns the socket URL that carries it. */
async function mintSocketUrl(headers: Record<string, string>): Promise<string> {
  const ticketResponse = await fetch(`${origin}/api/auth/websocket-ticket`, {
    method: "POST",
    headers,
  });
  NodeAssert.ok(ticketResponse.ok, `WebSocket authentication failed: ${ticketResponse.status}`);
  const ticket = decodeTicket(await ticketResponse.json());
  return `${origin.replace("http:", "ws:")}/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}&wsTicket=${encodeURIComponent(ticket.ticket)}`;
}

/**
 * Each reconnect mints its own ticket because a reused ticket never opens. Busy CI runners can
 * exceed the default ten-second open timeout while a provider starts, so opens get more time
 * and a failed open is retried.
 */
async function connect(headers: Record<string, string>) {
  const socketUrl = Effect.promise(() => mintSocketUrl(headers));
  const socket = Socket.layerWebSocket(socketUrl, { openTimeout: 60_000 }).pipe(
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
  );
  return RpcClient.layerProtocolSocket({ retryTransientErrors: true }).pipe(
    Layer.provide(socket),
    Layer.provide(RpcSerialization.layerJson),
  );
}

const makeClient = () => RpcClient.make(WsRpcGroup);
type Client = Effect.Success<ReturnType<typeof makeClient>>;

/** Thread helpers bound to one connection. */
function makeHelpers(client: Client, projectId: ProjectId, instanceId: ProviderInstanceId) {
  const modelSelection = { instanceId, model: model! };

  /** Follows the thread until `check` returns a value, or fails at the deadline. */
  const waitFor = <A>(
    threadId: ThreadId,
    label: string,
    check: (projection: OrchestrationV2ThreadProjection) => A | undefined,
    timeoutMs = scenarioTimeoutMs,
  ) => {
    let latest: OrchestrationV2ThreadProjection | undefined;
    return client["orchestration.subscribeThread"]({ threadId }).pipe(
      Stream.mapEffect(
        Effect.fn(function* (item) {
          NodeFS.appendFileSync(
            NodePath.join(evidence, `events-${threadId}.ndjson`),
            JSON.stringify(item) + "\n",
          );
          const projection =
            item.kind === "snapshot"
              ? item.projection
              : yield* client["orchestration.getThreadProjection"]({ threadId });
          latest = projection;
          return check(projection);
        }),
      ),
      Stream.filter((value): value is A => value !== undefined),
      Stream.take(1),
      Stream.runHead,
      Effect.timeoutOption(timeoutMs),
      Effect.map((result) => {
        if (latest) writeEvidence(`projection-${threadId}.json`, latest);
        const value = Option.flatten(result);
        if (Option.isSome(value)) return value.value;
        return fail(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${label}`);
      }),
    );
  };

  const waitForRunEnd = (threadId: ThreadId, messageId: MessageId, label: string) =>
    waitFor(threadId, label, (projection) => {
      const run = runFor(projection, messageId);
      return run && TERMINAL_RUN_STATUSES.has(run.status) ? { projection, run } : undefined;
    });

  const projection = (threadId: ThreadId) =>
    client["orchestration.getThreadProjection"]({ threadId }).pipe(
      Effect.tap((value) => Effect.sync(() => writeEvidence(`projection-${threadId}.json`, value))),
    );

  const send = Effect.fn("verify-provider-live.send")(function* (threadId: ThreadId, text: string) {
    const messageId = MessageId.make(NodeCrypto.randomUUID());
    yield* client["orchestration.dispatchCommand"]({
      type: "message.dispatch",
      commandId: CommandId.make(NodeCrypto.randomUUID()),
      createdBy: "user",
      creationSource: "web",
      threadId,
      messageId,
      text,
      attachments: [],
      dispatchMode: { type: "start_immediately" },
    });
    return messageId;
  });

  const launch = Effect.fn("verify-provider-live.launch")(function* (
    title: string,
    text: string,
    runtimeMode: RuntimeMode = "full-access",
    workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy = { type: "root" },
  ) {
    const threadId = ThreadId.make(NodeCrypto.randomUUID());
    const messageId = MessageId.make(NodeCrypto.randomUUID());
    yield* client["orchestration.launchThread"]({
      commandId: CommandId.make(NodeCrypto.randomUUID()),
      threadId,
      projectId,
      title,
      generateTitle: false,
      modelSelection,
      runtimeMode,
      interactionMode: "default",
      workspaceStrategy,
      initialMessage: { messageId, text, attachments: [] },
    });
    return { threadId, messageId };
  });

  /** Sends a no-tools turn asking for `token` and asserts the reply contains it. */
  const askForToken = Effect.fn("verify-provider-live.askForToken")(function* (
    threadId: ThreadId,
    text: string,
    token: string,
    label: string,
  ) {
    const messageId = yield* send(threadId, text);
    const ended = yield* waitForRunEnd(threadId, messageId, label);
    if (ended.run.status !== "completed") fail(`The ${label} ended ${ended.run.status}`);
    if (!assistantText(ended.projection, ended.run).includes(token))
      fail(`The ${label} reply did not contain ${token}`);
    return ended;
  });

  return { client, waitFor, waitForRunEnd, projection, send, launch, askForToken };
}

/**
 * The Auto setting the provider itself reported back in its native event logs:
 * Claude Code's init message and Codex's thread settings. A provider that
 * silently falls back from Auto reports something else. Undefined when the
 * provider reports nothing this check knows how to read.
 */
function reportedAutoSettings(): ReadonlyArray<string> | undefined {
  const directory = NodePath.join(home, "userdata/logs/provider");
  if (!NodeFS.existsSync(directory)) return undefined;
  const reported: Array<string> = [];
  for (const file of NodeFS.readdirSync(directory)) {
    for (const line of NodeFS.readFileSync(NodePath.join(directory, file), "utf8").split("\n")) {
      const json = line.indexOf("{");
      if (json < 0 || !line.includes("incoming")) continue;
      let event: unknown;
      try {
        event = (JSON.parse(line.slice(json)) as { event?: unknown }).event;
      } catch {
        continue;
      }
      if (typeof event !== "object" || event === null) continue;
      const { direction, payload } = event as { direction?: unknown; payload?: unknown };
      if (direction !== "incoming" || typeof payload !== "object" || payload === null) continue;
      const message = payload as {
        type?: unknown;
        subtype?: unknown;
        permissionMode?: unknown;
        method?: unknown;
        params?: { threadSettings?: { approvalsReviewer?: unknown } };
      };
      if (message.type === "system" && message.subtype === "init")
        reported.push(`permissionMode ${String(message.permissionMode)}`);
      if (message.method === "thread/settings/updated")
        reported.push(
          `approvalsReviewer ${String(message.params?.threadSettings?.approvalsReviewer)}`,
        );
    }
  }
  return reported.length === 0 ? undefined : reported;
}

/**
 * Runs one scenario, recording a failure instead of propagating it. Time spent
 * accumulates, since some scenarios continue after the restart.
 */
const attempt = <A, E, R>(name: ScenarioName, body: Effect.Effect<A, E, R>) => {
  const startedAt = Date.now();
  return body.pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        if (scenario(name).status === "skipped") scenario(name).status = "passed";
      }),
    ),
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        scenario(name).status = "failed";
        const value = Cause.squash(cause);
        scenario(name).detail = value instanceof Error ? value.message : String(value);
        console.error(`${name}: ${scenario(name).detail}`);
        return undefined;
      }),
    ),
    Effect.ensuring(
      Effect.sync(() => {
        const entry = scenario(name);
        entry.seconds = Math.round((entry.seconds + (Date.now() - startedAt) / 1000) * 10) / 10;
      }),
    ),
  );
};

function skip(name: ScenarioName, detail: string) {
  scenario(name).status = "skipped";
  scenario(name).detail = detail;
}

/** Stops the server by the process it was started as, including its process group. */
async function stopServer(child: ReturnType<typeof NodeChildProcess.spawn>) {
  if (child.exitCode === null && child.signalCode === null) {
    const stopped = new Promise<void>((done) => child.once("exit", () => done()));
    child.kill("SIGTERM");
    const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
    await stopped;
    clearTimeout(deadline);
  }
  // Kill only the process group created above, including lingering provider processes.
  if (child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  }
}

try {
  await server.ready;
  const tokenResponse = await fetch(`${origin}/oauth/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: bootstrap,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    }),
  });
  NodeAssert.ok(tokenResponse.ok, `Authentication failed: ${tokenResponse.status}`);
  const token = Schema.decodeUnknownSync(Schema.Struct({ access_token: Schema.String }))(
    await tokenResponse.json(),
  );
  const headers = {
    Authorization: `Bearer ${token.access_token}`,
    "Content-Type": "application/json",
    [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION),
  };
  const projectId = ProjectId.make(NodeCrypto.randomUUID());
  const created = await fetch(`${origin}/api/projects/mutate`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      type: "project.create",
      commandId: NodeCrypto.randomUUID(),
      projectId,
      title: "Provider verification",
      workspaceRoot: project,
    }),
  });
  NodeAssert.ok(created.ok, `Project creation failed: ${created.status} ${await created.text()}`);
  const instanceId = ProviderInstanceId.make(provider);

  const fileName = `canary-${NodeCrypto.randomBytes(4).toString("hex")}.txt`;
  const fileContent = `styal canary ${NodeCrypto.randomUUID()}`;
  const replyToken = randomToken("TOKEN");
  const subagentToken = randomToken("SUB");

  // Phase 1: every first turn, on one server process.
  const firstPhase = Effect.gen(function* () {
    const helpers = makeHelpers(yield* makeClient(), projectId, instanceId);
    const { client, waitFor, waitForRunEnd, send, launch, askForToken } = helpers;

    const snapshot = yield* attempt(
      "provider",
      Effect.gen(function* () {
        const refreshed = yield* client["server.refreshProviders"]({ instanceId });
        const config = yield* client["server.getConfig"]({});
        const entry: ServerProvider | undefined =
          config.providers.find((candidate) => candidate.instanceId === instanceId) ??
          refreshed.providers.find((candidate) => candidate.instanceId === instanceId);
        writeEvidence("provider.json", entry ?? config.providers);
        if (!entry) fail(`Provider instance ${provider} is not configured`);
        reportedVersion = entry.version?.match(/\d+\.\d+\.\d+/)?.[0] ?? entry.version;
        if (!entry.enabled) fail("Provider is disabled");
        if (!entry.installed) fail(`Provider is not installed: ${entry.message ?? ""}`);
        if (entry.status !== "ready")
          fail(`Provider status is ${entry.status}: ${entry.message ?? ""}`);
        if (entry.auth.status === "unauthenticated")
          fail(`Provider is not authenticated: ${entry.message ?? ""}`);
        if (expectedVersion !== undefined && reportedVersion !== expectedVersion)
          fail(`Provider reports version ${entry.version}, expected ${expectedVersion}`);
        scenario("provider").detail =
          `version ${entry.version ?? "unknown"}, auth ${entry.auth.status}${entry.auth.type ? ` (${entry.auth.type})` : ""}`;
        return entry;
      }),
    );
    if (!snapshot) return undefined;

    // Tool turn, checkpoint and resume share one thread; cold resume continues it.
    const toolTurn = !runToolTurn
      ? undefined
      : yield* attempt(
          "tool-turn",
          Effect.gen(function* () {
            const logOffset = logSize();
            const { threadId, messageId } = yield* launch(
              "Provider verification",
              `This is an automated provider check. Using your file-writing or shell tool, create a file named ${fileName} in the current working directory whose entire content is the single line: ${fileContent}\nDo not create or change any other file. After the file exists, reply with exactly ${replyToken} and nothing else.`,
            );
            const { projection, run } = yield* waitForRunEnd(threadId, messageId, "the tool turn");
            inspect("tool-turn", projection, logOffset);
            if (run.status !== "completed") fail(`Run ended ${run.status}`);
            const path = NodePath.join(project, fileName);
            if (!NodeFS.existsSync(path)) fail(`${fileName} was not created`);
            const written = NodeFS.readFileSync(path, "utf8");
            if (written.trim() !== fileContent)
              fail(`${fileName} has unexpected content: ${JSON.stringify(written)}`);
            if (!assistantText(projection, run).includes(replyToken))
              fail("Assistant reply did not contain the token");
            scenario("tool-turn").detail = `run ${run.ordinal} completed; file and token verified`;
            return { threadId, run, nativeThreadId: nativeThreadId(projection, run) };
          }),
        );

    if (toolTurn && selected("checkpoint")) {
      yield* attempt(
        "checkpoint",
        Effect.gen(function* () {
          const checkpoint = yield* waitFor(
            toolTurn.threadId,
            "the turn checkpoint",
            (projection) => {
              const run = projection.runs.find((candidate) => candidate.id === toolTurn.run.id);
              const id = run?.checkpointId;
              const found = id
                ? projection.checkpoints.find((entry) => entry.id === id)
                : undefined;
              return found && found.status !== "missing" ? found : undefined;
            },
          );
          if (checkpoint.status !== "ready") fail(`Checkpoint status is ${checkpoint.status}`);
          if (!checkpoint.files.some((file) => file.path.endsWith(fileName)))
            fail(`Checkpoint does not include ${fileName}: ${JSON.stringify(checkpoint.files)}`);
          scenario("checkpoint").detail =
            `checkpoint ready with ${checkpoint.files.length} file(s)`;
        }),
      );
    }

    if (toolTurn && selected("resume")) {
      yield* attempt(
        "resume",
        Effect.gen(function* () {
          const logOffset = logSize();
          const { projection, run } = yield* askForToken(
            toolTurn.threadId,
            "Without using any tools, reply with only the exact token you replied with in your previous answer.",
            replyToken,
            "resume turn",
          );
          inspect("resume", projection, logOffset);
          if (run.providerThreadId !== toolTurn.run.providerThreadId)
            fail(
              `The follow-up ran on provider thread ${run.providerThreadId}, not ${toolTurn.run.providerThreadId}`,
            );
          scenario("resume").detail =
            `run ${run.ordinal} recalled the token on the same provider thread`;
        }),
      );
    }

    // An agent shell that inherits T3CODE_PORT starts styal dev servers and CLIs
    // on this server's port.
    if (selected("server-env")) {
      yield* attempt(
        "server-env",
        Effect.gen(function* () {
          const logOffset = logSize();
          const envFile = `env-${NodeCrypto.randomBytes(4).toString("hex")}.txt`;
          const { threadId, messageId } = yield* launch(
            "Provider environment verification",
            `This is an automated provider check. Run this exact shell command: printenv T3CODE_PORT > ${envFile}; true\nThen reply with DONE.`,
          );
          const { projection, run } = yield* waitForRunEnd(
            threadId,
            messageId,
            "the environment turn",
          );
          inspect("server-env", projection, logOffset);
          if (run.status !== "completed") fail(`Run ended ${run.status}`);
          const path = NodePath.join(project, envFile);
          if (!NodeFS.existsSync(path)) fail(`${envFile} was not created`);
          const value = NodeFS.readFileSync(path, "utf8").trim();
          if (value !== "") fail(`The agent's shell inherited T3CODE_PORT=${value}`);
          scenario("server-env").detail = "the agent's shell did not inherit T3CODE_PORT";
        }),
      );
    }

    // Interrupt in its own thread, so it does not depend on the scenarios above.
    if (selected("interrupt")) {
      yield* attempt(
        "interrupt",
        Effect.gen(function* () {
          const logOffset = logSize();
          const { threadId, messageId } = yield* launch(
            "Provider interrupt verification",
            "This is an automated provider check. Run this exact shell command in the foreground and wait for it to finish: sleep 120\nDo not run it in the background. When it finishes, reply with DONE.",
          );
          const observed = yield* waitFor(threadId, "the long command to start", (projection) => {
            const run = runFor(projection, messageId);
            if (run && TERMINAL_RUN_STATUSES.has(run.status))
              fail(`Run ended ${run.status} before the interrupt`);
            if (run?.status !== "running") return undefined;
            return projection.turnItems.some(
              (item) =>
                item.runId === run.id &&
                item.type === "command_execution" &&
                item.input.includes("sleep 120"),
            )
              ? run
              : undefined;
          });
          const requestedAt = Date.now();
          yield* client["orchestration.dispatchCommand"]({
            type: "run.interrupt",
            commandId: CommandId.make(NodeCrypto.randomUUID()),
            threadId,
            runId: observed.id,
          });
          const { run } = yield* waitFor(
            threadId,
            "the interrupted run to end",
            (projection) => {
              const current = runFor(projection, messageId);
              return current && TERMINAL_RUN_STATUSES.has(current.status)
                ? { run: current }
                : undefined;
            },
            60_000,
          );
          const stopSeconds = ((Date.now() - requestedAt) / 1000).toFixed(1);
          if (run.status !== "interrupted" && run.status !== "cancelled")
            fail(`Run ended ${run.status} after the interrupt`);
          const followUpToken = randomToken("AFTER");
          const after = yield* askForToken(
            threadId,
            `Stop any earlier command. Without using any tools, reply with exactly ${followUpToken} and nothing else.`,
            followUpToken,
            "turn after the interrupt",
          );
          inspect("interrupt", after.projection, logOffset);
          scenario("interrupt").detail =
            `run ended ${run.status} ${stopSeconds}s after the interrupt; follow-up completed`;
        }),
      );
    }

    // Approval round trip: the agent's write must wait for an approval from the client.
    if (selected("approval")) {
      yield* attempt(
        "approval",
        Effect.gen(function* () {
          const logOffset = logSize();
          const approvalFile = `approved-${NodeCrypto.randomBytes(4).toString("hex")}.txt`;
          const { threadId, messageId } = yield* launch(
            "Provider approval verification",
            `This is an automated provider check. Run this exact shell command: echo approved > ${approvalFile}\nThen reply with DONE.`,
            "approval-required",
          );
          const approved: Array<string> = [];
          let ended:
            | { projection: OrchestrationV2ThreadProjection; run: OrchestrationV2Run }
            | undefined;
          while (!ended) {
            const next = yield* waitFor(
              threadId,
              approved.length === 0 ? "an approval request" : "the approved run to end",
              (projection) => {
                const pending = projection.runtimeRequests.find(
                  (request) => request.status === "pending" && !approved.includes(request.id),
                );
                if (pending) return { kind: "request" as const, pending };
                const run = runFor(projection, messageId);
                return run && TERMINAL_RUN_STATUSES.has(run.status)
                  ? { kind: "end" as const, run, projection }
                  : undefined;
              },
            );
            if (next.kind === "end") {
              ended = { projection: next.projection, run: next.run };
              continue;
            }
            const request = next.pending;
            if (approved.length >= 5) fail("The agent asked for more than five approvals");
            if (request.kind === "user_input" || request.kind === "auth_refresh")
              fail(`Expected an approval request, got ${request.kind}`);
            approved.push(request.id);
            yield* client["orchestration.dispatchCommand"]({
              type: "runtime-request.respond",
              commandId: CommandId.make(NodeCrypto.randomUUID()),
              threadId,
              requestId: request.id,
              decision: "accept",
            });
            const resolved = yield* waitFor(
              threadId,
              `request ${request.id} to resolve`,
              (projection) => {
                const current = projection.runtimeRequests.find((entry) => entry.id === request.id);
                return current && current.status !== "pending" ? current : undefined;
              },
              60_000,
            );
            if (resolved.status !== "resolved" || resolved.decision !== "accept")
              fail(
                `Request ${request.kind} ended ${resolved.status} (${resolved.decision ?? "no decision"})`,
              );
          }
          inspect("approval", ended.projection, logOffset);
          if (approved.length === 0) fail("The command ran without asking for approval");
          if (ended.run.status !== "completed") fail(`Run ended ${ended.run.status}`);
          if (!NodeFS.existsSync(NodePath.join(project, approvalFile)))
            fail(`${approvalFile} was not created after the approval`);
          const kinds = ended.projection.runtimeRequests
            .filter((request) => approved.includes(request.id))
            .map((request) => request.kind);
          scenario("approval").detail =
            `approved ${kinds.join(", ")}; file written and run completed`;
        }),
      );
    }

    // Auto: on providers with their own reviewer, a routine workspace write must
    // run without asking the user.
    if (selected("auto")) {
      if (snapshot.reviewsAutoMode !== true) {
        skip("auto", "skipped: the provider has no Auto reviewer");
      } else {
        yield* attempt(
          "auto",
          Effect.gen(function* () {
            const logOffset = logSize();
            const autoFile = `auto-${NodeCrypto.randomBytes(4).toString("hex")}.txt`;
            const autoToken = randomToken("AUTO");
            const { threadId, messageId } = yield* launch(
              "Provider Auto verification",
              `This is an automated provider check. Using your file-writing or shell tool, create a file named ${autoFile} in the current working directory whose entire content is the single line: auto\nDo not create or change any other file. After the file exists, reply with exactly ${autoToken} and nothing else.`,
              "auto",
            );
            const next = yield* waitFor(threadId, "the Auto turn to end", (projection) => {
              const pending = projection.runtimeRequests.find(
                (request) => request.status === "pending",
              );
              if (pending) return { kind: "request" as const, pending };
              const run = runFor(projection, messageId);
              return run && TERMINAL_RUN_STATUSES.has(run.status)
                ? { kind: "end" as const, run, projection }
                : undefined;
            });
            if (next.kind === "request") {
              // Decline so the thread does not wait on a client that is not there.
              yield* client["orchestration.dispatchCommand"]({
                type: "runtime-request.respond",
                commandId: CommandId.make(NodeCrypto.randomUUID()),
                threadId,
                requestId: next.pending.id,
                decision: "decline",
              });
              fail(`Auto asked for ${next.pending.kind} approval for a routine workspace write`);
            }
            inspect("auto", next.projection, logOffset);
            if (next.run.status !== "completed") fail(`Run ended ${next.run.status}`);
            if (!NodeFS.existsSync(NodePath.join(project, autoFile)))
              fail(`${autoFile} was not created`);
            if (!assistantText(next.projection, next.run).includes(autoToken))
              fail("Assistant reply did not contain the token");
            // A routine write can run without a prompt outside Auto too, so also
            // require the provider to report that it applied Auto.
            const reported = reportedAutoSettings();
            if (
              reported !== undefined &&
              !reported.some(
                (setting) =>
                  setting === "permissionMode auto" || setting === "approvalsReviewer auto_review",
              )
            )
              fail(`The provider did not report Auto: ${[...new Set(reported)].join(", ")}`);
            scenario("auto").detail =
              `file written without an approval request; provider reported ${reported ? [...new Set(reported)].join(", ") : "no mode"}`;
          }),
        );
      }
    }

    // Rewind: restore the checkpoint after the first turn, as the UI's rewind does, and
    // check the provider's conversation lost the second turn but kept the first.
    if (selected("rewind")) {
      if (snapshot.supportsConversationRollback === false) {
        skip("rewind", "skipped: the provider does not support conversation rollback");
      } else {
        yield* attempt(
          "rewind",
          Effect.gen(function* () {
            const logOffset = logSize();
            const keptWord = randomToken("KEPT");
            const rewoundWord = randomToken("REWOUND");
            const rewindFile = `rewind-${NodeCrypto.randomBytes(4).toString("hex")}.txt`;
            const { threadId, messageId } = yield* launch(
              "Provider rewind verification",
              `This is an automated provider check. Your first code word is ${keptWord}. Without using any tools, reply with exactly OK.`,
              "full-access",
              // File restore is refused in a checkout other threads share, so use a worktree.
              // A named branch skips the model-generated rename, which is not under test.
              {
                type: "worktree",
                baseRef: projectBranch,
                branch: `canary/rewind-${NodeCrypto.randomUUID().slice(0, 8)}`,
              },
            );
            const kept = yield* waitForRunEnd(threadId, messageId, "the turn to keep");
            if (kept.run.status !== "completed") fail(`The kept run ended ${kept.run.status}`);
            const keptCheckpoint = yield* waitFor(
              threadId,
              "the kept turn's checkpoint",
              (projection) => {
                const run = projection.runs.find((candidate) => candidate.id === kept.run.id);
                return projection.checkpoints.find(
                  (entry) => entry.id === run?.checkpointId && entry.status === "ready",
                );
              },
            );
            const rewound = yield* waitForRunEnd(
              threadId,
              yield* send(
                threadId,
                `Your second code word is ${rewoundWord}. Run this exact shell command: echo rewind > ${rewindFile}\nThen reply with DONE.`,
              ),
              "the turn to rewind",
            );
            if (rewound.run.status !== "completed")
              fail(`The rewound run ended ${rewound.run.status}`);
            const worktree = rewound.projection.thread.worktreePath;
            if (!worktree) fail("The rewind thread has no worktree");
            const rewindPath = NodePath.join(worktree, rewindFile);
            if (!NodeFS.existsSync(rewindPath))
              fail(`${rewindFile} was not created in ${worktree}`);
            yield* waitFor(threadId, "the rewound turn's checkpoint", (projection) => {
              const run = projection.runs.find((candidate) => candidate.id === rewound.run.id);
              return projection.checkpoints.find(
                (entry) => entry.id === run?.checkpointId && entry.status === "ready",
              );
            });
            const commandId = CommandId.make(NodeCrypto.randomUUID());
            yield* client["orchestration.dispatchCommand"]({
              type: "checkpoint.rollback",
              commandId,
              threadId,
              scopeId: keptCheckpoint.scopeId,
              checkpointId: keptCheckpoint.id,
            });
            const rolledBack = yield* waitFor(threadId, "the rollback", (projection) => {
              if (projection.thread.rollbackFailure?.requestId === commandId)
                fail(`Rollback failed: ${projection.thread.rollbackFailure.message}`);
              const run = projection.runs.find((candidate) => candidate.id === rewound.run.id);
              return run?.status === "rolled_back" ? projection : undefined;
            });
            const keptAfter = rolledBack.runs.find((candidate) => candidate.id === kept.run.id);
            if (keptAfter?.status !== "completed")
              fail(`The kept run is ${keptAfter?.status} after the rewind`);
            if (NodeFS.existsSync(rewindPath)) fail(`${rewindFile} still exists after the rewind`);
            const recallMessageId = yield* send(
              threadId,
              "Without using any tools, reply with every code word given to you earlier in this conversation, or NONE if there are none.",
            );
            const recall = yield* waitForRunEnd(threadId, recallMessageId, "turn after the rewind");
            if (recall.run.status !== "completed")
              fail(`The turn after the rewind ended ${recall.run.status}`);
            const reply = assistantText(recall.projection, recall.run);
            if (reply.includes(rewoundWord))
              fail(`The provider still recalled ${rewoundWord} from the rewound turn`);
            if (!reply.includes(keptWord))
              fail(`The provider no longer recalled ${keptWord} from the kept turn`);
            inspect("rewind", recall.projection, logOffset);
            scenario("rewind").detail =
              "file removed, second turn rolled back, provider recalled only the first turn's code word";
          }),
        );
      }
    }

    // Native subagent: the provider's own subagent tool, not styal's delegate_task.
    let subagentThread: ThreadId | undefined;
    if (selected("native-subagent")) {
      const tool = NATIVE_SUBAGENT_TOOL[snapshot.driver];
      if (!tool) {
        skip(
          "native-subagent",
          `skipped: no native subagent tool is defined for ${snapshot.driver}`,
        );
      } else {
        subagentThread = yield* attempt(
          "native-subagent",
          Effect.gen(function* () {
            const logOffset = logSize();
            const { threadId, messageId } = yield* launch(
              "Provider subagent verification",
              `This is an automated provider check. Use ${tool} to start exactly one subagent with this task: "Reply with exactly ${subagentToken} and nothing else." Do not use delegate_task or any styal tool. When the subagent finishes, reply with exactly the subagent's answer.`,
            );
            const { run } = yield* waitForRunEnd(threadId, messageId, "the subagent turn");
            if (run.status !== "completed") fail(`Run ended ${run.status}`);
            // Claude Code can run the subagent in the background and end its turn; the
            // answer then arrives in a later run once the subagent finishes.
            const projection = yield* waitFor(
              threadId,
              "the native subagent to finish and its answer to be reported",
              (current) => {
                const native = current.subagents.filter(
                  (task) => task.origin === "provider_native",
                );
                const settled =
                  native.length > 0 &&
                  native.every((task) => TERMINAL_SUBAGENT_STATUSES.has(task.status)) &&
                  current.runs.every((entry) => TERMINAL_RUN_STATUSES.has(entry.status));
                const reported = current.messages.some(
                  (message) => message.role === "assistant" && message.text.includes(subagentToken),
                );
                const failed = native.some((task) => task.status !== "completed");
                return settled && (reported || failed) ? current : undefined;
              },
            );
            inspect("native-subagent", projection, logOffset);
            const native = projection.subagents.filter(
              (task) => task.origin === "provider_native" && task.driver === snapshot.driver,
            );
            if (native.length === 0)
              fail(
                `No provider-native subagent was recorded (${projection.subagents.length} subagent(s) in total)`,
              );
            if (!native.some((task) => task.status === "completed"))
              fail(`Native subagent status: ${native.map((task) => task.status).join(", ")}`);
            if (projection.subagents.some((task) => task.origin === "app_owned"))
              fail("The agent used styal's delegate_task instead of its own subagent tool");
            if (
              !projection.messages.some(
                (message) => message.role === "assistant" && message.text.includes(subagentToken),
              )
            )
              fail("The parent never reported the subagent's token");
            scenario("native-subagent").detail = `${native.length} native subagent(s) completed`;
            return threadId;
          }),
        );
        if (subagentThread) {
          // Not passed until the follow-up after the restart completes.
          scenario("native-subagent").status = "skipped";
          scenario("native-subagent").detail = "not run";
        }
      }
    }

    return { toolTurn, subagentThread };
  }).pipe(Effect.scoped, Effect.provide(await connect(headers)));
  const first = await Effect.runPromise(firstPhase, { signal: abort.signal });

  // Phase 2: restart the server on the same home, then continue the threads cold.
  const needsRestart =
    first !== undefined &&
    ((selected("cold-resume") && first.toolTurn !== undefined) ||
      first.subagentThread !== undefined);
  if (needsRestart) {
    const restartOffset = logSize();
    await stopServer(server.child);
    server = startServer();
    await server.ready;
    inspect("restart", undefined, restartOffset);

    const secondPhase = Effect.gen(function* () {
      const { client, projection, askForToken } = makeHelpers(
        yield* makeClient(),
        projectId,
        instanceId,
      );

      const toolTurn = first.toolTurn;
      if (toolTurn && selected("cold-resume")) {
        yield* attempt(
          "cold-resume",
          Effect.gen(function* () {
            const logOffset = logSize();
            const { run } = yield* askForToken(
              toolTurn.threadId,
              "Without using any tools, reply with only the exact token you replied with in your first answer in this conversation.",
              replyToken,
              "cold resume turn",
            );
            // A stray turn result after resume can start or reopen work, so look again later.
            yield* Effect.sleep("5 seconds");
            const settled = yield* projection(toolTurn.threadId);
            inspect("cold-resume", settled, logOffset);
            const open = settled.runs.filter((entry) => !TERMINAL_RUN_STATUSES.has(entry.status));
            if (open.length > 0)
              fail(
                `Thread did not settle: run(s) ${open.map((entry) => `${entry.ordinal} ${entry.status}`).join(", ")}`,
              );
            const latest = settled.runs.find((entry) => entry.id === run.id);
            if (latest?.status !== "completed") fail(`The cold resume run is ${latest?.status}`);
            if (settled.runs.at(-1)?.id !== run.id)
              fail("Another run started after the cold resume");
            if (run.providerThreadId !== toolTurn.run.providerThreadId)
              fail(
                `Resumed on provider thread ${run.providerThreadId}, not ${toolTurn.run.providerThreadId}`,
              );
            const nativeAfter = nativeThreadId(settled, run);
            if (toolTurn.nativeThreadId && nativeAfter !== toolTurn.nativeThreadId)
              fail(`Native thread changed from ${toolTurn.nativeThreadId} to ${nativeAfter}`);
            scenario("cold-resume").detail =
              `run ${run.ordinal} recalled the token after a restart${toolTurn.nativeThreadId ? " on the same native thread" : ""}; thread settled`;
          }),
        );
      }

      const subagentThread = first.subagentThread;
      if (subagentThread) {
        yield* attempt(
          "native-subagent",
          Effect.gen(function* () {
            const logOffset = logSize();
            const before = yield* projection(subagentThread);
            // Persisted subagent items must still decode after the restart.
            for (const task of before.subagents) {
              if (task.childThreadId)
                yield* client["orchestration.getThreadProjection"]({
                  threadId: task.childThreadId,
                });
            }
            const after = yield* askForToken(
              subagentThread,
              "Without using any tools, reply with only the exact token the subagent returned.",
              subagentToken,
              "follow-up after the restart",
            );
            inspect("native-subagent", after.projection, logOffset);
            scenario("native-subagent").detail =
              `${before.subagents.filter((task) => task.origin === "provider_native").length} native subagent(s) completed; follow-up after a restart completed`;
          }),
        );
      }
    }).pipe(Effect.scoped, Effect.provide(await connect(headers)));
    await Effect.runPromise(secondPhase, { signal: abort.signal });
  }

  for (const name of ["checkpoint", "resume", "cold-resume"] as const) {
    if (selected(name) && scenario(name).detail === "not run")
      skip(name, "skipped: the tool turn failed");
  }

  if (selected("clean-projection")) {
    const entries = [...offenses].flatMap(([label, found]) =>
      found.map((line) => `${label}: ${line}`),
    );
    writeEvidence("offenses.json", Object.fromEntries(offenses));
    scenario("clean-projection").status = entries.length === 0 ? "passed" : "failed";
    scenario("clean-projection").detail =
      entries.length === 0
        ? `no errors, notices, failed work or server warnings across ${inspected} check(s)`
        : entries.slice(0, 10).join("; ") +
          (entries.length > 10 ? `; and ${entries.length - 10} more (offenses.json)` : "");
  }
} catch (error) {
  const first = scenarios.find((entry) => entry.status === "skipped" && entry.detail === "not run");
  if (first) {
    first.status = "failed";
    first.detail = error instanceof Error ? error.message : String(error);
  }
  console.error(String(error));
} finally {
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  await stopServer(server.child);
}

const passed =
  scenario("provider").status === "passed" &&
  !scenarios.some((entry) => entry.status === "failed" || entry.detail === "not run");
const result = { provider, version: reportedVersion, model, scenarios };
writeEvidence("result.json", { ...result, passed, evidence });
console.log(JSON.stringify(result));
process.exit(passed ? 0 : 1);
