#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off globalTimers:off - standalone fake CLI with no workspace imports.
/* oxlint-disable t3code/no-global-process-runtime -- standalone fake CLI process has no Effect runtime. */
/**
 * A fake `codex` CLI for tests and local verification. Point a Codex
 * provider's binary path at a launcher from `install` and the server runs
 * real sessions against it without an OpenAI account:
 *
 *   node apps/server/scripts/fake-codex.ts install <dir> [--scenario <file>]
 *
 * `app-server` answers the provider status check (signed in with an API key,
 * one `fake-codex` model) and runs turns. `exec` answers text generation with
 * placeholder values for the requested output schema.
 *
 * A scenario file scripts turns by prompt text. The first turn whose `match`
 * appears in the prompt runs, and a turn without `match` accepts any prompt.
 * When nothing matches, the reply echoes the prompt.
 *
 *   { "turns": [{ "match": "add a test", "steps": [
 *       { "type": "reasoning", "text": "Looking at the tests." },
 *       { "type": "command", "command": "vp test", "output": "1 passed", "exitCode": 0 },
 *       { "type": "writeFile", "path": "src/a.test.ts", "content": "..." },
 *       { "type": "message", "text": "Added the test." }
 *   ] }] }
 *
 * `writeFile` writes inside the session's working directory, so checkpoints
 * and diffs see a real change. A `hold` step keeps the turn running until it
 * is interrupted. `"error": "..."` on a turn fails it after its steps.
 *
 * Steps start 250 ms apart, like a provider waiting on its model. The server
 * captures the pre-turn checkpoint while the turn starts, so a file written
 * instantly would already be in that baseline and the turn diff would be
 * empty. Set `"stepDelayMs"` on the scenario to change the spacing.
 *
 * This file only imports Node built-ins so it can run from any checkout,
 * including an upstream T3 Code checkout that generates import fixtures.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

const SCENARIO_ENV = "STYAL_FAKE_CODEX_SCENARIO";
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
  | { readonly type: "writeFile"; readonly path: string; readonly content: string }
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
  /** Settles when the server interrupts the turn, at any point in its steps. */
  readonly interrupted: Promise<"interrupted">;
  readonly interrupt: () => void;
}

function makeActiveTurn(turnId: string): ActiveTurn {
  let interrupt = () => {};
  const interrupted = new Promise<"interrupted">((resolve) => {
    interrupt = () => resolve("interrupted");
  });
  return { turnId, interrupted, interrupt };
}

function runAppServer(): void {
  const threads = new Map<string, { cwd: string }>();
  let activeTurn: ActiveTurn | null = null;

  const threadResponse = (params: JsonObject, threadId: string) => {
    const cwd = typeof params.cwd === "string" ? params.cwd : process.cwd();
    const model = typeof params.model === "string" ? params.model : MODEL;
    const createdAt = nowSeconds();
    threads.set(threadId, { cwd });
    return {
      thread: {
        id: threadId,
        sessionId: threadId,
        preview: "",
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
    for (const step of turn.steps) {
      const delay = new Promise<"elapsed">((resolve) =>
        setTimeout(() => resolve("elapsed"), scenario.stepDelayMs ?? 250),
      );
      if ((await Promise.race([delay, active.interrupted])) === "interrupted") {
        interrupted = true;
        break;
      }
      if (step.type === "hold") {
        await active.interrupted;
        interrupted = true;
        break;
      }
      try {
        emitStep(threadId, turnId, cwd, step);
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
        send({ id, result: { turn: { id: turnId, items: [], status: "inProgress" } } });
        activeTurn = makeActiveTurn(turnId);
        void runTurn(threadId, activeTurn, prompt);
        return;
      }
      case "turn/interrupt":
        send({ id, result: {} });
        if (activeTurn !== null && activeTurn.turnId === params.turnId) activeTurn.interrupt();
        return;
      default:
        // Includes config/mcpServer/reload, which the server awaits without a timeout.
        return send({ id, result: {} });
    }
  };

  const input = NodeReadline.createInterface({ input: process.stdin });
  input.on("line", (line) => {
    if (line.trim().length === 0) return;
    const message = JSON.parse(line) as { id?: unknown; method?: string; params?: JsonObject };
    // Responses to server requests and notifications such as `initialized` need no reply.
    if (message.method === undefined || !("id" in message)) return;
    handleRequest(message.id, message.method, message.params ?? {});
  });
  input.on("close", () => process.exit(0));
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

/** Writes a `codex` launcher for this script into a directory and prints its path. */
function runInstall(argv: ReadonlyArray<string>): void {
  const directory = argv[0];
  if (!directory) {
    process.stderr.write("usage: fake-codex.ts install <dir> [--scenario <file>]\n");
    process.exit(2);
  }
  const scenario = flagValue(argv, "--scenario");
  const script = NodePath.resolve(import.meta.filename);
  NodeFS.mkdirSync(directory, { recursive: true });
  if (process.platform === "win32") {
    const launcher = NodePath.resolve(directory, "codex.cmd");
    NodeFS.writeFileSync(
      launcher,
      [
        "@echo off",
        ...(scenario ? [`set "${SCENARIO_ENV}=${NodePath.resolve(scenario)}"`] : []),
        `node "${script}" %*`,
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
      `exec node ${quote(script)} "$@"`,
      "",
    ].join("\n"),
    "utf8",
  );
  NodeFS.chmodSync(launcher, 0o755);
  process.stdout.write(`${launcher}\n`);
}
