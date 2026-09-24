// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - writes fixture files for a child process.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CodexSettings, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../src/config.ts";
import { checkCodexProviderStatus } from "../src/provider/Layers/CodexProvider.ts";
import { makeCodexSessionRuntime } from "../src/provider/Layers/CodexSessionRuntime.ts";
import { makeCodexTextGeneration } from "../src/textGeneration/CodexTextGeneration.ts";

const fakeCodexPath = NodePath.join(import.meta.dirname, "fake-codex.ts");
const decodeCodexSettings = Schema.decodeSync(CodexSettings);

/** Installs a launcher for the fake with the given scenario and returns its path and workspace. */
const installFakeCodex = (scenario: unknown) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fake-codex-test-"));
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

const startSession = (launcher: string, workspace: string) =>
  makeCodexSessionRuntime({
    threadId: ThreadId.make("thread-fake-codex"),
    binaryPath: launcher,
    cwd: workspace,
    runtimeMode: "full-access",
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
