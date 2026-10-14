// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalFetch:off globalConsole:off globalConsoleInEffect:off globalDateInEffect:off preferSchemaOverJson:off - Host-side process verifier retains raw wire evidence and owns deadline timers.
/**
 * Real provider turn verifier, used by the provider canary before a provider
 * release is allowed for automatic updates. Run from the repository root:
 *
 *   node apps/server/scripts/verify-provider-live.ts --provider claudeAgent \
 *     --model claude-haiku-5-5 [--timeout 180] [--expect-version 2.1.300]
 *
 * Boots a real server with a fresh T3 home and a disposable Git project and
 * drives real provider turns over the WebSocket RPC API. The provider uses the
 * CLI authentication available to this process (logins in HOME or API key
 * variables). Evidence is retained in the printed directory.
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
import { Socket } from "effect/unstable/socket";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
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
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
} from "@t3tools/contracts";

const { values } = NodeUtil.parseArgs({
  options: {
    provider: { type: "string" },
    model: { type: "string" },
    timeout: { type: "string", default: "180" },
    "expect-version": { type: "string" },
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

const BUILT_IN_PROVIDERS = [
  "codex",
  "claudeAgent",
  "cursor",
  "grok",
  "pi",
  "opencode",
  "antigravity",
] as const;
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

// The server must not update providers itself while the canary pins a version.
NodeFS.writeFileSync(
  NodePath.join(home, "userdata/settings.json"),
  JSON.stringify(
    {
      defaultThreadEnvMode: "local",
      enableProviderUpdateChecks: false,
      autoUpdateProviders: false,
      enableAgentBrowserAccess: false,
      providers: Object.fromEntries(
        BUILT_IN_PROVIDERS.filter((key) => key !== provider).map((key) => [
          key,
          { enabled: false },
        ]),
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
  return env;
}

const server = NodeChildProcess.spawn(
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
const bootstrapPipe = server.stdio[3];
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
let serverOutput = "";
for (const pipe of [server.stdout, server.stderr])
  pipe?.on("data", (data: Buffer) => {
    const text = data.toString().replaceAll(bootstrap, "[REDACTED]");
    NodeFS.appendFileSync(NodePath.join(evidence, "server.log"), text);
    serverOutput = (serverOutput + text).slice(-8192);
    if (serverOutput.includes("startup phase: complete")) ready.resolve();
  });
server.once("error", ready.reject);
server.once("exit", (code) => ready.reject(new Error(`Server exited ${code}`)));
const startupDeadline = setTimeout(
  () => ready.reject(new Error("Server startup timed out")),
  90_000,
);

const abort = new AbortController();
const onSignal = () => abort.abort(new Error("Verification interrupted"));
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);

interface ScenarioResult {
  readonly name: string;
  status: "passed" | "failed" | "skipped";
  detail: string;
}
const scenarios: Array<ScenarioResult> = [
  { name: "provider", status: "skipped", detail: "not run" },
  { name: "tool-turn", status: "skipped", detail: "not run" },
  { name: "checkpoint", status: "skipped", detail: "not run" },
  { name: "resume", status: "skipped", detail: "not run" },
  { name: "interrupt", status: "skipped", detail: "not run" },
];
const scenario = (name: string) => scenarios.find((entry) => entry.name === name)!;
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

try {
  await ready.promise.finally(() => clearTimeout(startupDeadline));
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
  const ticketResponse = await fetch(`${origin}/api/auth/websocket-ticket`, {
    method: "POST",
    headers,
  });
  NodeAssert.ok(ticketResponse.ok, `WebSocket authentication failed: ${ticketResponse.status}`);
  const ticket = Schema.decodeUnknownSync(Schema.Struct({ ticket: Schema.String }))(
    await ticketResponse.json(),
  );
  const socket = Socket.layerWebSocket(
    `${origin.replace("http:", "ws:")}/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}&wsTicket=${encodeURIComponent(ticket.ticket)}`,
  ).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal));
  const protocol = RpcClient.layerProtocolSocket().pipe(
    Layer.provide(socket),
    Layer.provide(RpcSerialization.layerJson),
  );
  const instanceId = ProviderInstanceId.make(provider);
  const modelSelection = { instanceId, model };

  const program = Effect.gen(function* () {
    const client = yield* RpcClient.make(WsRpcGroup);

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

    const send = (threadId: ThreadId, text: string) =>
      Effect.gen(function* () {
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

    const launch = (title: string, text: string) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make(NodeCrypto.randomUUID());
        const messageId = MessageId.make(NodeCrypto.randomUUID());
        yield* client["orchestration.launchThread"]({
          commandId: CommandId.make(NodeCrypto.randomUUID()),
          threadId,
          projectId,
          title,
          generateTitle: false,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          initialMessage: { messageId, text, attachments: [] },
        });
        return { threadId, messageId };
      });

    /** Runs one scenario, recording a failure instead of propagating it. */
    const attempt = <A, E, R>(name: string, body: Effect.Effect<A, E, R>) =>
      body.pipe(
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
      );

    // Provider snapshot.
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
    if (!snapshot) return;

    // 1. Tool turn, 2. checkpoint, 3. resume share one thread.
    const fileName = `canary-${NodeCrypto.randomBytes(4).toString("hex")}.txt`;
    const fileContent = `styal canary ${NodeCrypto.randomUUID()}`;
    const replyToken = `TOKEN-${NodeCrypto.randomBytes(6).toString("hex").toUpperCase()}`;
    const toolTurn = yield* attempt(
      "tool-turn",
      Effect.gen(function* () {
        const { threadId, messageId } = yield* launch(
          "Provider verification",
          `This is an automated provider check. Using your file-writing or shell tool, create a file named ${fileName} in the current working directory whose entire content is the single line: ${fileContent}\nDo not create or change any other file. After the file exists, reply with exactly ${replyToken} and nothing else.`,
        );
        const { projection, run } = yield* waitForRunEnd(threadId, messageId, "the tool turn");
        if (run.status !== "completed") fail(`Run ended ${run.status}`);
        const path = NodePath.join(project, fileName);
        if (!NodeFS.existsSync(path)) fail(`${fileName} was not created`);
        const written = NodeFS.readFileSync(path, "utf8");
        if (written.trim() !== fileContent)
          fail(`${fileName} has unexpected content: ${JSON.stringify(written)}`);
        if (!assistantText(projection, run).includes(replyToken))
          fail("Assistant reply did not contain the token");
        scenario("tool-turn").detail = `run ${run.id} completed; file and token verified`;
        return { threadId, run };
      }),
    );

    if (toolTurn) {
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
            `checkpoint ${checkpoint.id} ready with ${checkpoint.files.length} file(s)`;
        }),
      );

      yield* attempt(
        "resume",
        Effect.gen(function* () {
          const messageId = yield* send(
            toolTurn.threadId,
            "Without using any tools, reply with only the exact token you replied with in your previous answer.",
          );
          const { projection, run } = yield* waitForRunEnd(
            toolTurn.threadId,
            messageId,
            "the resume turn",
          );
          if (run.status !== "completed") fail(`Run ended ${run.status}`);
          if (!assistantText(projection, run).includes(replyToken))
            fail("Assistant reply did not contain the token from the previous turn");
          if (run.providerThreadId !== toolTurn.run.providerThreadId)
            fail(
              `The follow-up ran on provider thread ${run.providerThreadId}, not ${toolTurn.run.providerThreadId}`,
            );
          scenario("resume").detail =
            `run ${run.id} recalled the token on the same provider thread`;
        }),
      );
    } else {
      scenario("checkpoint").detail = "skipped: the tool turn failed";
      scenario("resume").detail = "skipped: the tool turn failed";
    }

    // 4. Interrupt in its own thread, so it does not depend on the scenarios above.
    yield* attempt(
      "interrupt",
      Effect.gen(function* () {
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
        const followUpToken = `AFTER-${NodeCrypto.randomBytes(6).toString("hex").toUpperCase()}`;
        const followUp = yield* send(
          threadId,
          `Stop any earlier command. Without using any tools, reply with exactly ${followUpToken} and nothing else.`,
        );
        const after = yield* waitForRunEnd(threadId, followUp, "the turn after the interrupt");
        if (after.run.status !== "completed") fail(`The follow-up run ended ${after.run.status}`);
        if (!assistantText(after.projection, after.run).includes(followUpToken))
          fail("The follow-up reply did not contain its token");
        scenario("interrupt").detail =
          `run ended ${run.status} ${stopSeconds}s after the interrupt; follow-up completed`;
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(protocol));
  await Effect.runPromise(program, { signal: abort.signal });
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
  await stopServer(server);
}

const passed = scenarios.every((entry) => entry.status === "passed");
const result = { provider, version: reportedVersion, model, scenarios };
writeEvidence("result.json", { ...result, passed, evidence });
console.log(JSON.stringify(result));
process.exit(passed ? 0 : 1);

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
