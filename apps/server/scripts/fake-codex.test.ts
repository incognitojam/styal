// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - writes fixture files for a child process.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CodexSettings, ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../src/config.ts";
import { checkCodexProviderStatus } from "../src/provider/Layers/CodexProvider.ts";
import * as CodexProtocol from "effect-codex-app-server/protocol";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { makeCodexTextGeneration } from "../src/textGeneration/CodexTextGeneration.ts";

const fakeCodexPath = NodePath.join(import.meta.dirname, "fake-codex.ts");
const decodeCodexSettings = Schema.decodeSync(CodexSettings);

/** Installs a launcher for the fake with the given scenario and returns its path and workspace. */
const installFakeCodex = (scenario: unknown) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const scratch = NodePath.resolve(import.meta.dirname, "../../../.scratch");
      NodeFS.mkdirSync(scratch, { recursive: true });
      const directory = NodeFS.mkdtempSync(NodePath.join(scratch, "upstream-v2-fake-codex-test-"));
      const scenarioPath = NodePath.join(directory, "scenario.json");
      // These sessions capture no checkpoints, so steps need no spacing.
      NodeFS.writeFileSync(
        scenarioPath,
        JSON.stringify({ stepDelayMs: 0, ...(scenario as object) }),
        "utf8",
      );
      const launcher = NodeChildProcess.execFileSync(
        process.execPath,
        [fakeCodexPath, "install", NodePath.join(directory, "bin"), "--scenario", scenarioPath],
        { encoding: "utf8" },
      ).trim();
      const workspace = NodePath.join(directory, "workspace");
      NodeFS.mkdirSync(workspace);
      return { directory, launcher, workspace };
    }),
    ({ directory }) =>
      Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
  );

/** Exercises the same V2 protocol transport the production adapter uses, against a real child. */
const startSession = (launcher: string, workspace: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(launcher, ["app-server"], {
        cwd: workspace,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const encoder = new TextEncoder();
    const protocol = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
      stdio: Stdio.make({
        args: Effect.succeed([]),
        stdin: child.stdout,
        stdout: () =>
          Sink.mapInput(child.stdin, (chunk: string | Uint8Array) =>
            typeof chunk === "string" ? encoder.encode(chunk) : chunk,
          ),
        stderr: () => Sink.drain,
      }),
    });
    let nativeThreadId = "";
    let nativeTurnId = "";
    const events = Stream.merge(
      protocol.incomingNotifications.pipe(
        Stream.map((event) => ({
          method: event.method,
          payload: event.params,
          textDelta:
            event.params && typeof event.params === "object" && "delta" in event.params
              ? String(event.params.delta)
              : undefined,
          requestId: undefined as string | number | undefined,
        })),
      ),
      protocol.incomingRequests.pipe(
        Stream.map((event) => ({
          method: event.method,
          payload: event.params,
          textDelta: undefined as string | undefined,
          requestId: event.id,
        })),
      ),
    );
    return {
      events,
      start: () =>
        Effect.gen(function* () {
          yield* protocol.request("initialize", {
            clientInfo: { name: "styal_fake_codex_test", version: "1" },
          });
          yield* protocol.notify("initialized", {});
          const response = yield* protocol.request("thread/start", {
            cwd: workspace,
            model: "fake-codex",
            approvalPolicy: "never",
            sandbox: "danger-full-access",
          });
          const result = response as { thread: { id: string }; model: string };
          nativeThreadId = result.thread.id;
          return { model: result.model };
        }),
      sendTurn: (input: { input: string }) =>
        Effect.gen(function* () {
          const result = yield* protocol.request("turn/start", {
            threadId: nativeThreadId,
            input: [{ type: "text", text: input.input }],
          });
          nativeTurnId = (result as { turn: { id: string } }).turn.id;
        }),
      respondToUserInput: (id: string | number, answers: Record<string, string>) =>
        protocol.respond(id, {
          answers: Object.fromEntries(
            Object.entries(answers).map(([key, value]) => [key, { answers: [value] }]),
          ),
        }),
      interruptTurn: () =>
        protocol.request("turn/interrupt", { threadId: nativeThreadId, turnId: nativeTurnId }),
      close: child.kill(),
    };
  });

it.layer(
  ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "fake-codex-test-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  ),
)("fake-codex", (it) => {
  it.effect("runs a scripted turn through a real Codex session", () =>
    Effect.gen(function* () {
      const { launcher, workspace } = yield* installFakeCodex({
        turns: [
          {
            match: "add a note",
            steps: [
              { type: "reasoning", text: "Checking the workspace." },
              { type: "command", command: "ls", output: "README.md\n", exitCode: 0 },
              { type: "writeFile", path: "notes/todo.md", content: "- first\n- second\n" },
              { type: "message", text: "Added notes/todo.md with two items." },
            ],
          },
        ],
      });
      const runtime = yield* startSession(launcher, workspace);
      const turnEvents = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.method === "turn/completed"),
        Stream.runCollect,
        Effect.forkScoped,
      );

      const session = yield* runtime.start();
      assert.equal(session.model, "fake-codex");
      yield* runtime.sendTurn({ input: "Please add a note about the plan." });
      const events = Array.from(yield* Fiber.join(turnEvents));

      const completedItems = events
        .filter((event) => event.method === "item/completed")
        .map((event) => (event.payload as { item: { type: string } }).item.type);
      assert.deepEqual(completedItems, [
        "reasoning",
        "commandExecution",
        "fileChange",
        "agentMessage",
      ]);
      const streamedText = events
        .filter((event) => event.method === "item/agentMessage/delta")
        .map((event) => event.textDelta)
        .join("");
      assert.equal(streamedText, "Added notes/todo.md with two items.");
      const completed = events.at(-1)?.payload as { turn: { status: string } };
      assert.equal(completed.turn.status, "completed");
      assert.equal(
        NodeFS.readFileSync(NodePath.join(workspace, "notes/todo.md"), "utf8"),
        "- first\n- second\n",
      );
      yield* runtime.close;
    }).pipe(Effect.scoped),
  );

  it.effect("asks scripted questions and quotes the answers", () =>
    Effect.gen(function* () {
      const { launcher, workspace } = yield* installFakeCodex({
        turns: [
          {
            steps: [
              {
                type: "question",
                questions: [
                  {
                    id: "store",
                    header: "Store",
                    question: "Where should the cache live?",
                    options: [{ label: "Memory", description: "Fastest." }],
                  },
                  { id: "ttl", header: "TTL", question: "How long should entries live?" },
                ],
              },
              { type: "message", text: "Caching in {{answer:store}} for {{answer:ttl}}." },
            ],
          },
        ],
      });
      const runtime = yield* startSession(launcher, workspace);
      const turnEvents = yield* runtime.events.pipe(
        Stream.tap((event) =>
          event.method === "item/tool/requestUserInput" && event.requestId
            ? runtime
                .respondToUserInput(event.requestId, { store: "Redis", ttl: "1 hour" })
                .pipe(Effect.orDie)
            : Effect.void,
        ),
        Stream.takeUntil((event) => event.method === "turn/completed"),
        Stream.runCollect,
        Effect.forkScoped,
      );

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "Add a cache." });
      const events = Array.from(yield* Fiber.join(turnEvents));

      const request = events.find((event) => event.method === "item/tool/requestUserInput");
      const payload = request?.payload as { questions: Array<{ id: string }> } | undefined;
      assert.deepEqual(
        payload?.questions.map((question) => question.id),
        ["store", "ttl"],
      );
      const streamedText = events
        .filter((event) => event.method === "item/agentMessage/delta")
        .map((event) => event.textDelta)
        .join("");
      assert.equal(streamedText, "Caching in Redis for 1 hour.");
      const completed = events.at(-1)?.payload as { turn: { status: string } };
      assert.equal(completed.turn.status, "completed");
      yield* runtime.close;
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a held turn running until it is interrupted", () =>
    Effect.gen(function* () {
      const { launcher, workspace } = yield* installFakeCodex({
        turns: [{ steps: [{ type: "message", text: "Working on it." }, { type: "hold" }] }],
      });
      const runtime = yield* startSession(launcher, workspace);
      const turnEvents = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.method === "turn/completed"),
        Stream.runCollect,
        Effect.forkScoped,
      );

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "Start something long." });
      yield* runtime.interruptTurn();
      const events = Array.from(yield* Fiber.join(turnEvents));

      const completed = events.at(-1)?.payload as { turn: { status: string } };
      assert.equal(completed.turn.status, "interrupted");
      yield* runtime.close;
    }).pipe(Effect.scoped),
  );

  it.effect("fails the turn when a file write leaves the workspace", () =>
    Effect.gen(function* () {
      const { directory, launcher, workspace } = yield* installFakeCodex({
        turns: [{ steps: [{ type: "writeFile", path: "../outside.txt", content: "no" }] }],
      });
      const runtime = yield* startSession(launcher, workspace);
      const turnEvents = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.method === "turn/completed"),
        Stream.runCollect,
        Effect.forkScoped,
      );

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "Write outside." });
      const events = Array.from(yield* Fiber.join(turnEvents));

      const completed = events.at(-1)?.payload as {
        turn: { status: string; error?: { message: string } };
      };
      assert.equal(completed.turn.status, "failed");
      assert.include(completed.turn.error?.message, "leaves the working directory");
      assert.isFalse(NodeFS.existsSync(NodePath.join(directory, "outside.txt")));
      yield* runtime.close;
    }).pipe(Effect.scoped),
  );

  it.effect("reports a signed-in provider with the fake model", () =>
    Effect.gen(function* () {
      const { launcher } = yield* installFakeCodex({ turns: [] });
      const status = yield* checkCodexProviderStatus(decodeCodexSettings({ binaryPath: launcher }));

      assert.equal(status.status, "ready");
      assert.equal(status.auth.status, "authenticated");
      assert.deepEqual(
        status.models.map((model) => model.slug),
        ["fake-codex"],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("answers thread title generation", () =>
    Effect.gen(function* () {
      const { launcher, workspace } = yield* installFakeCodex({ turns: [] });
      const textGeneration = yield* makeCodexTextGeneration(
        decodeCodexSettings({ binaryPath: launcher }),
      );

      const generated = yield* textGeneration.generateThreadTitle({
        cwd: workspace,
        message: "Please add a note about the plan.",
        modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "fake-codex"),
      });
      assert.equal(generated.title, "Fake Codex thread");
    }).pipe(Effect.scoped),
  );
});
