import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };
const at = (minute: number, second = 0) =>
  DateTime.makeUnsafe(
    `2026-01-01T00:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}Z`,
  );

const git = (cwd: string, args: ReadonlyArray<string>, committedAt?: DateTime.Utc) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const exitCode = yield* spawner.exitCode(
      ChildProcess.make("git", args, {
        cwd,
        ...(committedAt === undefined
          ? {}
          : {
              env: { GIT_COMMITTER_DATE: `@${DateTime.toEpochMillis(committedAt) / 1000} +0000` },
              extendEnv: true,
            }),
      }),
    );
    assert.equal(Number(exitCode), 0, `git ${args.join(" ")}`);
  }).pipe(Effect.provide(NodeServices.layer));

it.effect("tells the agent about a temporary worktree branch and its rename", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const project = yield* checkpointWorkspace("worktree-branch-note");
      const worktreesDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-worktree-branch-note-",
      });
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      const started: ProviderAdapter.ProviderAdapterV2TurnInput[] = [];
      let nextStartedAt = at(0);
      const providerThread = (threadId: ThreadId, now: DateTime.Utc) => ({
        id: ProviderThreadId.make(`provider-thread:${threadId}`),
        driver,
        providerInstanceId: instanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: { driver, nativeId: `native:${threadId}`, strength: "strong" as const },
        nativeConversationHeadRef: null,
        status: "idle" as const,
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      });
      const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
        instanceId,
        driver,
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: (input) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            return {
              instanceId,
              driver,
              providerSessionId: input.providerSessionId,
              providerSession: {
                id: input.providerSessionId,
                driver,
                providerInstanceId: instanceId,
                status: "ready",
                cwd: project,
                model: modelSelection.model,
                capabilities: CodexProviderCapabilitiesV2,
                createdAt: now,
                updatedAt: now,
                lastError: null,
              },
              events: Stream.fromQueue(events),
              ensureThread: ({ threadId }) =>
                Effect.succeed({
                  ...providerThread(threadId, now),
                  providerSessionId: input.providerSessionId,
                }),
              resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
              forkThread: () => Effect.die("unused"),
              startTurn: (turn) =>
                Effect.gen(function* () {
                  started.push(turn);
                  yield* Queue.offer(events, {
                    type: "provider_turn.updated",
                    driver,
                    providerTurn: {
                      id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                      providerThreadId: turn.providerThread.id,
                      nodeId: turn.rootNodeId,
                      runAttemptId: turn.attemptId,
                      nativeTurnRef: {
                        driver,
                        nativeId: `native:${turn.attemptId}`,
                        strength: "strong",
                      },
                      ordinal: turn.providerTurnOrdinal,
                      status: "running",
                      startedAt: nextStartedAt,
                      completedAt: null,
                    },
                  });
                }),
              steerTurn: () => Effect.die("unused"),
              interruptTurn: () => Effect.void,
              respondToRuntimeRequest: () => Effect.void,
              readThreadSnapshot: () => Effect.die("unused"),
              rollbackThread: () => Effect.die("unused"),
            };
          }),
      };
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        /** Sends a message whose provider turn starts at `startedAt`, and completes that turn. */
        const send = (threadId: ThreadId, text: string, startedAt: DateTime.Utc) =>
          Effect.gen(function* () {
            nextStartedAt = startedAt;
            const recorded = yield* orchestrator.streamDomainEvents.pipe(
              Stream.filter(
                (event) =>
                  event.type === "provider-turn.updated" &&
                  event.threadId === threadId &&
                  event.payload.status === "running",
              ),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkScoped,
            );
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`send:${threadId}:${text}`),
              threadId,
              messageId: MessageId.make(`message:${threadId}:${text}`),
              text,
              attachments: [],
              dispatchMode: { type: "start_immediately" },
              createdBy: "user",
              creationSource: "web",
            });
            const drained = yield* Effect.forkScoped(worker.drain());
            yield* Fiber.join(recorded);
            yield* Fiber.join(drained);
            const turn = started.at(-1)!;
            const projection = yield* orchestrator.getThreadProjection(threadId);
            const providerTurn = projection.providerTurns.find(
              (candidate) => candidate.runAttemptId === turn.attemptId,
            )!;
            const settled = yield* orchestrator.streamDomainEvents.pipe(
              Stream.filter(
                (event) =>
                  event.type === "run.updated" &&
                  event.payload.id === turn.runId &&
                  (event.payload.status === "waiting" || event.payload.status === "completed"),
              ),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkScoped,
            );
            yield* Queue.offer(events, {
              type: "provider_turn.updated",
              driver,
              providerTurn: { ...providerTurn, status: "completed", completedAt: startedAt },
            });
            yield* Queue.offer(events, {
              type: "turn.terminal",
              driver,
              providerThreadId: providerTurn.providerThreadId,
              providerTurnId: providerTurn.id,
              runOrdinal: turn.runOrdinal,
              threadDisposition: "reusable",
              status: "completed",
              failure: null,
            });
            yield* Fiber.join(settled);
            yield* worker.drain();
            return turn.message.text;
          });
        const createThread = (name: string, branch: string) =>
          Effect.gen(function* () {
            const threadId = ThreadId.make(`thread:${name}`);
            const worktreePath = path.join(worktreesDir, branch.replace("/", "-"));
            yield* git(project, ["worktree", "add", "-b", branch, worktreePath]);
            yield* orchestrator.dispatch({
              type: "thread.create",
              commandId: CommandId.make(`create:${name}`),
              threadId,
              projectId: ProjectId.make("project:worktree-branch-note"),
              title: name,
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch,
              worktreePath,
              createdBy: "user",
              creationSource: "web",
            });
            return { threadId, worktreePath };
          });

        const renamed = yield* createThread("renamed", "styal/0123abcd");
        const first = yield* send(renamed.threadId, "Tidy the theme", at(1));
        assert.include(
          first,
          "Note: this worktree's branch, `styal/0123abcd`, has a temporary name and may be renamed while you work.",
        );
        yield* git(
          renamed.worktreePath,
          ["branch", "-m", "styal/0123abcd", "styal/tidy-theme"],
          at(1, 5),
        );
        const second = yield* send(renamed.threadId, "Open a PR", at(2));
        assert.include(
          second,
          "Note: this worktree's branch `styal/0123abcd` was renamed to `styal/tidy-theme` after your previous turn started. The worktree folder keeps the old name.",
        );
        assert.notInclude(second, "has a temporary name");
        const third = yield* send(renamed.threadId, "Thanks", at(3));
        assert.notInclude(third, "worktree");

        // The agent renamed the branch again after the background rename.
        const movedOn = yield* createThread("moved-on", "styal/4567cdef");
        yield* send(movedOn.threadId, "Start the glass pass", at(1));
        yield* git(
          movedOn.worktreePath,
          ["branch", "-m", "styal/4567cdef", "styal/glass-pass"],
          at(1, 5),
        );
        yield* git(
          movedOn.worktreePath,
          ["branch", "-m", "styal/glass-pass", "feature/glass"],
          at(1, 30),
        );
        const afterAgentRename = yield* send(movedOn.threadId, "Push it", at(2));
        assert.include(
          afterAgentRename,
          "was renamed to `styal/glass-pass` after your previous turn started. The current branch is `feature/glass`.",
        );

        // A rename before the first turn leaves nothing stale to correct.
        const early = yield* createThread("early", "styal/89ab0123");
        yield* git(early.worktreePath, ["branch", "-m", "styal/89ab0123", "styal/early"], at(0));
        const earlyFirst = yield* send(early.threadId, "Hello", at(1));
        assert.notInclude(earlyFirst, "worktree");
        const earlySecond = yield* send(early.threadId, "Again", at(2));
        assert.notInclude(earlySecond, "worktree");
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name: "worktree-branch-note" },
            ProviderAdapterRegistry.layerSingle(adapter),
            { runEffectWorker: false },
          ),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);
