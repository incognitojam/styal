#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off globalTimers:off globalFetch:off - standalone fake CLI with no workspace imports.
/* oxlint-disable t3code/no-global-process-runtime -- standalone fake CLI process has no Effect runtime. */
/**
 * Fake `codex` CLI for tests: `install <dir>` writes a launcher to use as a Codex binary path.
 * Scenario files script turns by prompt text (see `Step`); an unmatched prompt is echoed back.
 * Steps start 250 ms apart so file writes land after the pre-turn checkpoint is captured.
 * Imports only Node built-ins so it runs from any checkout, including upstream T3 Code.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

const SCENARIO_ENV = "STYAL_FAKE_CODEX_SCENARIO";
const REQUEST_LOG_ENV = "STYAL_FAKE_CODEX_REQUEST_LOG";
const RPC_LOG_ENV = "STYAL_FAKE_CODEX_RPC_LOG";
const MODEL = "fake-codex";

type Step =
  | { readonly type: "message"; readonly text: string }
  | { readonly type: "reasoning"; readonly text: string }
  | {
      readonly type: "command";
      readonly command: string;
      readonly output?: string;
      readonly exitCode?: number;
    }
  | {
      readonly type: "backgroundCommand";
      readonly command: string;
      readonly processId: string;
      readonly output?: string;
    }
  | { readonly type: "writeFile"; readonly path: string; readonly content: string }
  | { readonly type: "question"; readonly questions: ReadonlyArray<JsonObject> }
  | { readonly type: "mcpCall"; readonly name: string; readonly arguments: JsonObject }
  | { readonly type: "approval"; readonly command: string }
  | { readonly type: "hold" };

interface ScenarioTurn {
  readonly match?: string;
  readonly steps: ReadonlyArray<Step>;
  readonly error?: string;
}

interface Scenario {
  readonly turns: ReadonlyArray<ScenarioTurn>;
  readonly stepDelayMs?: number;
}

type JsonObject = Record<string, unknown>;

interface McpServer {
  readonly url: string;
  readonly http_headers?: Readonly<Record<string, string>>;
}

const [mode, ...args] = process.argv.slice(2);

switch (mode) {
  case "app-server":
    runAppServer();
    break;
  case "exec":
    runExec(args);
    break;
  case "install":
    runInstall(args);
    break;
  default:
    process.stderr.write(`fake-codex: unsupported command '${mode ?? ""}'\n`);
    process.exit(2);
}

function readScenario(): Scenario {
  const path = process.env[SCENARIO_ENV];
  if (!path) return { turns: [] };
  return JSON.parse(NodeFS.readFileSync(path, "utf8")) as Scenario;
}

function send(message: JsonObject): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function notify(method: string, params: JsonObject): void {
  send({ method, params });
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

interface ActiveTurn {
  readonly turnId: string;
  /** Settles when the server interrupts or steers the turn, at any point in its steps. */
  readonly interrupted: Promise<"interrupted" | "steered">;
  readonly interrupt: () => void;
  readonly steer: (text: string) => void;
  steerText?: string;
}

interface BackgroundCommand {
  readonly turnId: string;
  readonly item: JsonObject;
}

function makeActiveTurn(turnId: string): ActiveTurn {
  let settle = (_reason: "interrupted" | "steered") => {};
  const interrupted = new Promise<"interrupted" | "steered">((resolve) => {
    settle = resolve;
  });
  const active: ActiveTurn = {
    turnId,
    interrupted,
    interrupt: () => settle("interrupted"),
    steer: (text) => {
      active.steerText = text;
      settle("steered");
    },
  };
  return active;
}

function runAppServer(): void {
  const threads = new Map<string, { cwd: string; mcpServer: McpServer | undefined }>();
  const backgroundCommands = new Map<string, Map<string, BackgroundCommand>>();
  const pendingRequests = new Map<string, (result: JsonObject) => void>();
  let activeTurn: ActiveTurn | null = null;

  /** Sends a request to the server and settles with its result. */
  const request = (method: string, params: JsonObject) =>
    new Promise<JsonObject>((resolve) => {
      const id = `fake-codex-${NodeCrypto.randomUUID()}`;
      pendingRequests.set(id, resolve);
      send({ id, method, params });
    });

  const threadResponse = (params: JsonObject, threadId: string) => {
    const cwd = typeof params.cwd === "string" ? params.cwd : process.cwd();
    const model = typeof params.model === "string" ? params.model : MODEL;
    const createdAt = nowSeconds();
    // The adapter sends its own server as a dotted `mcp_servers.<name>` config key.
    const config = (params.config ?? {}) as Record<string, unknown>;
    const mcpServer = Object.entries(config).find(([key]) =>
      key.startsWith("mcp_servers."),
    )?.[1] as McpServer | undefined;
    threads.set(threadId, { cwd, mcpServer });
    return {
      thread: {
        id: threadId,
        sessionId: threadId,
        preview: "",
        projectId: null,
        ephemeral: false,
        modelProvider: "openai",
        createdAt,
        updatedAt: createdAt,
        status: { type: "idle" },
        cwd,
        cliVersion: "0.0.0",
        source: "appServer",
        turns: [],
      },
      model,
      modelProvider: "openai",
      cwd,
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: { type: "dangerFullAccess" },
    };
  };

  const runTurn = async (threadId: string, active: ActiveTurn, prompt: string) => {
    const turnId = active.turnId;
    const thread = threads.get(threadId);
    const cwd = thread?.cwd ?? process.cwd();
    const scenario = readScenario();
    const turn = scenario.turns.find(
      (candidate) => candidate.match === undefined || prompt.includes(candidate.match),
    ) ?? { steps: [{ type: "message", text: `Fake Codex reply to: ${prompt}` }] };

    notify("turn/started", {
      threadId,
      turn: { id: turnId, items: [], status: "inProgress", startedAt: nowSeconds() },
    });

    let interrupted = false;
    let error = turn.error;
    const answers: Record<string, ReadonlyArray<string>> = {};
    for (const step of turn.steps) {
      const delay = new Promise<"elapsed">((resolve) =>
        setTimeout(() => resolve("elapsed"), scenario.stepDelayMs ?? 250),
      );
      const outcome = await Promise.race([delay, active.interrupted]);
      const settled =
        outcome === "elapsed" && step.type === "hold" ? await active.interrupted : outcome;
      if (settled !== "elapsed") {
        interrupted = settled === "interrupted";
        if (!interrupted)
          emitStep(threadId, turnId, cwd, {
            type: "message",
            text: `Steered: ${active.steerText}`,
          });
        break;
      }
      if (step.type === "approval") {
        const response = await Promise.race([
          request("item/commandExecution/requestApproval", {
            threadId,
            turnId,
            itemId: NodeCrypto.randomUUID(),
            command: step.command,
            cwd,
            startedAtMs: Date.now(),
          }),
          active.interrupted,
        ]);
        if (typeof response === "string") {
          interrupted = true;
          break;
        }
        if (response.decision !== "accept" && response.decision !== "acceptForSession") {
          emitStep(threadId, turnId, cwd, { type: "message", text: "Command denied by user." });
          interrupted = true;
          break;
        }
        emitStep(threadId, turnId, cwd, {
          type: "command",
          command: step.command,
          output: "approved",
        });
        continue;
      }
      if (step.type === "question") {
        const response = await Promise.race([
          request("item/tool/requestUserInput", {
            isBlocking: true,
            threadId,
            turnId,
            itemId: NodeCrypto.randomUUID(),
            questions: step.questions,
          }),
          active.interrupted,
        ]);
        if (typeof response === "string") {
          interrupted = true;
          break;
        }
        const answered = (response.answers ?? {}) as Record<string, { answers: string[] }>;
        for (const [questionId, answer] of Object.entries(answered)) {
          answers[questionId] = answer.answers;
        }
        continue;
      }
      try {
        if (step.type === "backgroundCommand") {
          const commands = backgroundCommands.get(threadId) ?? new Map<string, BackgroundCommand>();
          if (commands.has(step.processId)) {
            throw new Error(`fake-codex: background process '${step.processId}' already exists`);
          }
          const item = {
            type: "commandExecution",
            id: NodeCrypto.randomUUID(),
            command: step.command,
            cwd,
            processId: step.processId,
            source: "unifiedExecStartup",
            status: "inProgress",
            commandActions: [],
            aggregatedOutput: null,
            exitCode: null,
            durationMs: null,
          };
          commands.set(step.processId, {
            turnId,
            item: { ...item, aggregatedOutput: step.output ?? "" },
          });
          backgroundCommands.set(threadId, commands);
          notify("item/started", { threadId, turnId, item, startedAtMs: Date.now() });
          if (step.output) {
            notify("item/commandExecution/outputDelta", {
              threadId,
              turnId,
              itemId: item.id,
              delta: step.output,
            });
          }
          continue;
        }
        if (step.type === "mcpCall") {
          if (!thread?.mcpServer) throw new Error("fake-codex: no injected MCP server");
          await callMcpTool(thread.mcpServer, step);
          continue;
        }
        emitStep(
          threadId,
          turnId,
          cwd,
          step.type === "message"
            ? {
                ...step,
                text: step.text.replace(
                  /\{\{answer:([^}]+)\}\}/g,
                  (_, questionId: string) => answers[questionId]?.join(", ") ?? "",
                ),
              }
            : step,
        );
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
        break;
      }
    }

    notify("thread/tokenUsage/updated", {
      threadId,
      turnId,
      tokenUsage: { total: tokenBreakdown(), last: tokenBreakdown() },
    });
    const status = interrupted ? "interrupted" : error === undefined ? "completed" : "failed";
    notify("turn/completed", {
      threadId,
      turn: {
        id: turnId,
        items: [],
        status,
        completedAt: nowSeconds(),
        ...(status === "failed" ? { error: { message: error } } : {}),
      },
    });
    if (activeTurn === active) activeTurn = null;
  };

  const handleRequest = (id: unknown, method: string, params: JsonObject) => {
    const rpcLog = process.env[RPC_LOG_ENV];
    if (rpcLog) NodeFS.appendFileSync(rpcLog, `${JSON.stringify({ method, params })}\n`, "utf8");
    switch (method) {
      case "initialize":
        return send({
          id,
          result: {
            userAgent: "fake-codex",
            codexHome: process.env.CODEX_HOME ?? process.cwd(),
            platformFamily: process.platform === "win32" ? "windows" : "unix",
            platformOs: process.platform === "darwin" ? "macos" : process.platform,
          },
        });
      case "account/read":
        return send({ id, result: { requiresOpenaiAuth: false, account: { type: "apiKey" } } });
      case "account/rateLimits/read":
        return send({ id, result: { rateLimits: {} } });
      case "skills/list":
        return send({ id, result: { data: [] } });
      case "model/list":
        return send({
          id,
          result: {
            data: [
              {
                id: MODEL,
                model: MODEL,
                displayName: "Fake Codex",
                description: "Scripted replies for tests.",
                hidden: false,
                isDefault: true,
                defaultReasoningEffort: "medium",
                supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Medium" }],
              },
            ],
          },
        });
      case "thread/start":
        return send({ id, result: threadResponse(params, NodeCrypto.randomUUID()) });
      case "thread/resume":
        return send({
          id,
          result: threadResponse(params, String(params.threadId ?? NodeCrypto.randomUUID())),
        });
      case "turn/start": {
        const threadId = String(params.threadId);
        const turnId = NodeCrypto.randomUUID();
        const prompt = Array.isArray(params.input)
          ? params.input
              .map((part: { type?: string; text?: string }) =>
                part.type === "text" ? (part.text ?? "") : "",
              )
              .join("\n")
          : "";
        const requestLog = process.env[REQUEST_LOG_ENV];
        if (requestLog) {
          NodeFS.appendFileSync(
            requestLog,
            `${JSON.stringify({ threadId, input: params.input ?? [] })}\n`,
            "utf8",
          );
        }
        send({ id, result: { turn: { id: turnId, items: [], status: "inProgress" } } });
        activeTurn = makeActiveTurn(turnId);
        void runTurn(threadId, activeTurn, prompt);
        return;
      }
      case "turn/steer": {
        if (activeTurn === null || params.expectedTurnId !== activeTurn.turnId) {
          send({ id, error: { code: -32602, message: "Steering targeted a non-active turn." } });
          return;
        }
        const text = Array.isArray(params.input)
          ? params.input.map((item: { text?: string }) => item.text ?? "").join("\n")
          : "";
        send({ id, result: { turnId: activeTurn.turnId } });
        activeTurn.steer(text);
        return;
      }
      case "turn/interrupt":
        send({ id, result: {} });
        if (activeTurn !== null && activeTurn.turnId === params.turnId) activeTurn.interrupt();
        return;
      case "thread/backgroundTerminals/list":
        return send({
          id,
          result: {
            data: Array.from(
              backgroundCommands.get(String(params.threadId))?.keys() ?? [],
              (processId) => ({ processId }),
            ),
            nextCursor: null,
          },
        });
      case "thread/backgroundTerminals/terminate": {
        const threadId = String(params.threadId);
        const commands = backgroundCommands.get(threadId);
        const processId = String(params.processId);
        const command = commands?.get(processId);
        send({ id, result: { terminated: command !== undefined } });
        if (command !== undefined) {
          commands?.delete(processId);
          notify("item/completed", {
            threadId,
            turnId: command.turnId,
            completedAtMs: Date.now(),
            item: { ...command.item, status: "failed", exitCode: 130, durationMs: 0 },
          });
        }
        return;
      }
      default:
        // Includes config/mcpServer/reload, which the server awaits without a timeout.
        return send({ id, result: {} });
    }
  };

  const input = NodeReadline.createInterface({ input: process.stdin });
  input.on("line", (line) => {
    if (line.trim().length === 0) return;
    const message = JSON.parse(line) as {
      id?: unknown;
      method?: string;
      params?: JsonObject;
      result?: JsonObject;
    };
    if (message.method === undefined && typeof message.id === "string") {
      const resolve = pendingRequests.get(message.id);
      pendingRequests.delete(message.id);
      resolve?.(message.result ?? {});
      return;
    }
    // Other responses and notifications such as `initialized` need no reply.
    if (message.method === undefined || !("id" in message)) return;
    handleRequest(message.id, message.method, message.params ?? {});
  });
  input.on("close", () => process.exit(0));
}

async function callMcpTool(server: McpServer, step: Extract<Step, { type: "mcpCall" }>) {
  const headers = new Headers({
    ...server.http_headers,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  });
  const rpc = async (method: string, params: JsonObject, id?: number) => {
    const response = await fetch(server.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(30_000),
    });
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) headers.set("mcp-session-id", sessionId);
    const raw = await response.text();
    if (!response.ok) throw new Error(`fake-codex: MCP HTTP ${response.status}: ${raw}`);
    if (id === undefined) return;
    const messages = response.headers.get("content-type")?.includes("text/event-stream")
      ? raw
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5))
      : [raw];
    const reply = messages
      .map(
        (message) =>
          JSON.parse(message) as {
            id?: number;
            error?: unknown;
            result?: { protocolVersion?: string; isError?: boolean };
          },
      )
      .find((message) => message.id === id);
    if (!reply || reply.error || reply.result?.isError) {
      throw new Error(`fake-codex: MCP ${method} failed: ${raw}`);
    }
    return reply.result;
  };
  const initialized = await rpc(
    "initialize",
    {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "fake-codex", version: "0.0.0" },
    },
    1,
  );
  headers.set("mcp-protocol-version", initialized?.protocolVersion ?? "2025-06-18");
  await rpc("notifications/initialized", {});
  await rpc("tools/call", { name: step.name, arguments: step.arguments }, 2);
}

function emitStep(threadId: string, turnId: string, cwd: string, step: Step): void {
  const itemId = NodeCrypto.randomUUID();
  const started = (item: JsonObject) =>
    notify("item/started", { threadId, turnId, startedAtMs: Date.now(), item });
  const completed = (item: JsonObject) =>
    notify("item/completed", { threadId, turnId, completedAtMs: Date.now(), item });

  switch (step.type) {
    case "message": {
      started({ type: "agentMessage", id: itemId, text: "" });
      for (const delta of chunks(step.text)) {
        notify("item/agentMessage/delta", { threadId, turnId, itemId, delta });
      }
      completed({ type: "agentMessage", id: itemId, text: step.text });
      return;
    }
    case "reasoning": {
      started({ type: "reasoning", id: itemId, summary: [], content: [] });
      notify("item/reasoning/summaryTextDelta", {
        threadId,
        turnId,
        itemId,
        summaryIndex: 0,
        delta: step.text,
      });
      completed({ type: "reasoning", id: itemId, summary: [step.text], content: [] });
      return;
    }
    case "command": {
      const item = { type: "commandExecution", id: itemId, command: step.command, cwd };
      started({ ...item, commandActions: [], status: "inProgress" });
      if (step.output) {
        notify("item/commandExecution/outputDelta", {
          threadId,
          turnId,
          itemId,
          delta: step.output,
        });
      }
      const exitCode = step.exitCode ?? 0;
      completed({
        ...item,
        commandActions: [],
        status: exitCode === 0 ? "completed" : "failed",
        aggregatedOutput: step.output ?? "",
        exitCode,
        durationMs: 0,
      });
      return;
    }
    case "writeFile": {
      const path = NodePath.resolve(cwd, step.path);
      if (!path.startsWith(NodePath.resolve(cwd) + NodePath.sep)) {
        throw new Error(`fake-codex: writeFile path '${step.path}' leaves the working directory`);
      }
      const previous = NodeFS.existsSync(path) ? NodeFS.readFileSync(path, "utf8") : null;
      const change = {
        path,
        kind: { type: previous === null ? "add" : "update" },
        diff: unifiedDiff(previous, step.content),
      };
      started({ type: "fileChange", id: itemId, changes: [change], status: "inProgress" });
      NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
      NodeFS.writeFileSync(path, step.content, "utf8");
      completed({ type: "fileChange", id: itemId, changes: [change], status: "completed" });
      return;
    }
    case "approval":
    case "question":
    case "mcpCall":
    case "hold":
      return;
  }
}

function chunks(text: string): ReadonlyArray<string> {
  const words = text.match(/\S+\s*/g) ?? [text];
  const result: string[] = [];
  for (let index = 0; index < words.length; index += 4) {
    result.push(words.slice(index, index + 4).join(""));
  }
  return result;
}

function lines(text: string): ReadonlyArray<string> {
  return text.length === 0 ? [] : text.replace(/\n$/, "").split("\n");
}

function unifiedDiff(previous: string | null, next: string): string {
  const before = lines(previous ?? "");
  const after = lines(next);
  return [
    `@@ -${before.length === 0 ? 0 : 1},${before.length} +1,${after.length} @@`,
    ...before.map((line) => `-${line}`),
    ...after.map((line) => `+${line}`),
    "",
  ].join("\n");
}

function tokenBreakdown() {
  return {
    totalTokens: 120,
    inputTokens: 100,
    cachedInputTokens: 0,
    outputTokens: 20,
    reasoningOutputTokens: 0,
  };
}

function flagValue(argv: ReadonlyArray<string>, flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

/** Text generation: fill every property the output schema asks for. */
function runExec(argv: ReadonlyArray<string>): void {
  const schemaPath = flagValue(argv, "--output-schema");
  const outputPath = flagValue(argv, "--output-last-message");
  if (!schemaPath || !outputPath) {
    process.stderr.write("fake-codex: exec needs --output-schema and --output-last-message\n");
    process.exit(2);
  }
  const schema = JSON.parse(NodeFS.readFileSync(schemaPath, "utf8")) as {
    properties?: Record<string, { type?: string }>;
  };
  const placeholders: Record<string, string> = {
    title: "Fake Codex thread",
    branch: "fake-codex-change",
    subject: "Apply fake Codex change",
    body: "Generated by fake Codex.",
  };
  const output: JsonObject = {};
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    output[name] =
      property.type === "array"
        ? []
        : property.type === "boolean"
          ? false
          : (placeholders[name] ?? `Fake ${name}`);
  }
  // Drain the prompt so the caller's stdin write never fails.
  process.stdin.resume();
  process.stdin.on("end", () => {
    NodeFS.writeFileSync(outputPath, JSON.stringify(output), "utf8");
    process.exit(0);
  });
}

/**
 * Writes a `codex` launcher for this script into a directory and prints its path. The launcher
 * runs the Node binary that ran `install`, so it works under a different HOME or PATH, where a
 * version manager's `node` shim may be missing or need to download a runtime.
 */
function runInstall(argv: ReadonlyArray<string>): void {
  const directory = argv[0];
  if (!directory) {
    process.stderr.write(
      "usage: fake-codex.ts install <dir> [--scenario <file>] [--request-log <file>] [--rpc-log <file>]\n",
    );
    process.exit(2);
  }
  const scenario = flagValue(argv, "--scenario");
  const requestLog = flagValue(argv, "--request-log");
  const rpcLog = flagValue(argv, "--rpc-log");
  const script = NodePath.resolve(import.meta.filename);
  NodeFS.mkdirSync(directory, { recursive: true });
  if (process.platform === "win32") {
    const launcher = NodePath.resolve(directory, "codex.cmd");
    NodeFS.writeFileSync(
      launcher,
      [
        "@echo off",
        ...(scenario ? [`set "${SCENARIO_ENV}=${NodePath.resolve(scenario)}"`] : []),
        ...(requestLog ? [`set "${REQUEST_LOG_ENV}=${NodePath.resolve(requestLog)}"`] : []),
        ...(rpcLog ? [`set "${RPC_LOG_ENV}=${NodePath.resolve(rpcLog)}"`] : []),
        `"${process.execPath}" "${script}" %*`,
        "exit /b %ERRORLEVEL%",
        "",
      ].join("\r\n"),
      "utf8",
    );
    process.stdout.write(`${launcher}\n`);
    return;
  }
  const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  const launcher = NodePath.resolve(directory, "codex");
  NodeFS.writeFileSync(
    launcher,
    [
      "#!/bin/sh",
      ...(scenario ? [`export ${SCENARIO_ENV}=${quote(NodePath.resolve(scenario))}`] : []),
      ...(requestLog ? [`export ${REQUEST_LOG_ENV}=${quote(NodePath.resolve(requestLog))}`] : []),
      ...(rpcLog ? [`export ${RPC_LOG_ENV}=${quote(NodePath.resolve(rpcLog))}`] : []),
      `exec ${quote(process.execPath)} ${quote(script)} "$@"`,
      "",
    ].join("\n"),
    "utf8",
  );
  NodeFS.chmodSync(launcher, 0o755);
  process.stdout.write(`${launcher}\n`);
}
