import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import { FORK_NOTE } from "./ForkNote.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };

it.effect(
  "sends the fork note until a turn carrying it completes, skipping provider commands",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("fork-note-delivery");
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const started: ProviderAdapter.ProviderAdapterV2TurnInput[] = [];
        // Texts whose turn the provider records and then refuses.
        const refuse = new Set<string>();
        // Holds a refusal until the test has seen its provider turn recorded.
        const releaseRefusal = yield* Deferred.make<void>();
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
                  cwd,
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
                forkThread: ({ targetThreadId }) =>
                  Effect.succeed({
                    ...providerThread(targetThreadId, now),
                    providerSessionId: input.providerSessionId,
                  }),
                startTurn: (turn) =>
                  Effect.gen(function* () {
                    started.push(turn);
                    // Like OpenCode, the turn is recorded before the provider answers.
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
                        startedAt: now,
                        completedAt: null,
                      },
                    });
                    if ([...refuse].some((text) => turn.message.text.endsWith(text))) {
                      yield* Deferred.await(releaseRefusal);
                      return yield* new ProviderAdapter.ProviderAdapterTurnStartError({
                        driver,
                        threadId: turn.threadId,
                        providerThreadId: turn.providerThread.id,
                        runId: turn.runId,
                        cause: "invalid request",
                      });
                    }
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
          const sourceThreadId = ThreadId.make("thread:fork-note-source");
          const forkThreadId = ThreadId.make("thread:fork-note-fork");
          /**
           * Sends a message and settles its provider turn: "completed" and
           * "failed" end the turn through provider events, as an adapter whose
           * start returned before the provider answered would; "refused" fails
           * the start itself after the provider turn was recorded.
           */
          const send = (
            threadId: ThreadId,
            text: string,
            outcome: "completed" | "failed" | "refused" = "completed",
          ) =>
            Effect.gen(function* () {
              const before = started.length;
              if (outcome === "refused") refuse.add(text);
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
              if (outcome === "refused") yield* Deferred.succeed(releaseRefusal, undefined);
              yield* Fiber.join(drained);
              assert.equal(started.length, before + 1, `"${text}" starts one provider turn`);
              const turn = started.at(-1)!;
              if (outcome !== "refused") {
                const projection = yield* orchestrator.getThreadProjection(threadId);
                const providerTurn = projection.providerTurns.find(
                  (candidate) => candidate.runAttemptId === turn.attemptId,
                )!;
                const settled = yield* orchestrator.streamDomainEvents.pipe(
                  Stream.filter(
                    (event) =>
                      event.type === "run.updated" &&
                      event.payload.id === turn.runId &&
                      (event.payload.status === "waiting" ||
                        event.payload.status === "completed" ||
                        event.payload.status === "failed"),
                  ),
                  Stream.take(1),
                  Stream.runDrain,
                  Effect.forkScoped,
                );
                yield* Queue.offer(events, {
                  type: "provider_turn.updated",
                  driver,
                  providerTurn: {
                    ...providerTurn,
                    status: outcome,
                    completedAt: yield* DateTime.now,
                  },
                });
                const terminal = {
                  type: "turn.terminal",
                  driver,
                  providerThreadId: providerTurn.providerThreadId,
                  providerTurnId: providerTurn.id,
                  runOrdinal: turn.runOrdinal,
                  threadDisposition: "reusable",
                } as const;
                yield* Queue.offer(
                  events,
                  outcome === "failed"
                    ? {
                        ...terminal,
                        status: "failed",
                        failureItemOrdinal: 1,
                        failure: makeProviderFailure({
                          message: "The provider rejected the prompt.",
                          code: "invalid_request",
                          class: "validation_error",
                        }),
                      }
                    : { ...terminal, status: "completed", failure: null },
                );
                yield* Fiber.join(settled);
                yield* worker.drain();
              }
              return { text: turn.message.text, attemptId: turn.attemptId, runId: turn.runId };
            });
          const forkTransfer = Effect.map(
            orchestrator.getThreadProjection(forkThreadId),
            (projection) =>
              projection.contextTransfers.find(
                (transfer) => transfer.type === "fork" && transfer.targetThreadId === forkThreadId,
              ),
          );

          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create-source"),
            threadId: sourceThreadId,
            projectId: ProjectId.make("project:fork-note"),
            title: "Fork note source",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
            createdBy: "user",
            creationSource: "web",
          });
          const source = yield* send(sourceThreadId, "Start the background check");
          assert.notInclude(source.text, FORK_NOTE);
          yield* orchestrator.dispatch({
            type: "thread.fork",
            commandId: CommandId.make("fork"),
            sourceThreadId,
            targetThreadId: forkThreadId,
            sourcePoint: { type: "run", runId: RunId.make(source.runId) },
            createdBy: "user",
            creationSource: "web",
          });

          const command = yield* send(forkThreadId, "/goal ship the fix");
          assert.equal(command.text, "/goal ship the fix", "a provider command is sent unprefixed");

          const refused = yield* send(forkThreadId, "Is the check done?", "refused");
          assert.include(refused.text, FORK_NOTE);
          const afterRefusal = yield* orchestrator.getThreadProjection(forkThreadId);
          assert.equal(afterRefusal.runs.find((run) => run.id === refused.runId)?.status, "failed");
          assert.isTrue(
            afterRefusal.providerTurns.some((turn) => turn.runAttemptId === refused.attemptId),
            "the refused attempt has a recorded provider turn",
          );

          // The start returned, then the provider failed the turn.
          const failed = yield* send(forkThreadId, "Try again", "failed");
          assert.include(failed.text, FORK_NOTE);

          const accepted = yield* send(forkThreadId, "One more time");
          assert.include(accepted.text, FORK_NOTE);
          assert.equal((yield* forkTransfer)?.forkNoteAttemptId, accepted.attemptId);

          const later = yield* send(forkThreadId, "And then?");
          assert.notInclude(later.text, FORK_NOTE);
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              { name: "fork-note-delivery" },
              ProviderAdapterRegistry.layerSingle(adapter),
              { runEffectWorker: false },
            ),
          ),
        );
      }),
    ),
);
