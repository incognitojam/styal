import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
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
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import { FORK_NOTE } from "./ForkNote.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const contextDelivery = (driverName: "codex" | "claudeAgent") =>
  Effect.scoped(
    Effect.gen(function* () {
      const driver = ProviderDriverKind.make(driverName);
      const instanceId = ProviderInstanceId.make(driverName);
      const modelSelection = { instanceId, model: "test-model" };
      const capabilities =
        driverName === "claudeAgent" ? ClaudeProviderCapabilitiesV2 : CodexProviderCapabilitiesV2;
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
        getCapabilities: () => Effect.succeed(capabilities),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: (input) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
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
                capabilities,
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
            return { ...runtime, compactThread: runtime.startTurn };
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
          sender: "user" | "agent" = "user",
          creationSource: "web" | "mcp" | "provider" = sender === "agent" ? "mcp" : "web",
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
              createdBy: sender,
              creationSource,
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
        const key = { host: "github.com", repository: "acme/app", number: 1484 };
        yield* orchestrator.dispatch({
          type: "thread.pull-request.link",
          commandId: CommandId.make("link-next-turn-pr"),
          threadId: sourceThreadId,
          ...key,
          url: "https://github.com/acme/app/pull/1484",
          source: "agent",
        });
        let syncOrdinal = 0;
        const sync = (state: "open" | "closed" | "merged") =>
          orchestrator.dispatch({
            type: "thread.pull-request-link.sync",
            commandId: CommandId.make(`sync-next-turn-pr:${++syncOrdinal}`),
            threadId: sourceThreadId,
            ...key,
            snapshot: {
              state,
              title: "Synthetic PR",
              headBranch: "feature/pr",
              baseBranch: "main",
              isDraft: false,
              updatedAt: null,
              syncedAt: "2026-11-15T14:08:00.000Z",
              mergedAt: state === "merged" ? "2026-11-15T14:08:00.000Z" : null,
            },
            stack: null,
          });
        yield* sync("open");
        const beforeSync = yield* orchestrator.getThreadProjection(sourceThreadId);
        yield* sync("closed");
        const afterSync = yield* orchestrator.getThreadProjection(sourceThreadId);
        assert.equal(afterSync.runs.length, beforeSync.runs.length);
        assert.deepEqual(afterSync.thread.updatedAt, beforeSync.thread.updatedAt);
        const noPrompt = yield* send(sourceThreadId, "/compact");
        assert.notInclude(
          (yield* send(sourceThreadId, "/goal check status")).text,
          "Since your last turn:",
        );
        assert.notInclude(noPrompt.text, "Since your last turn:");
        if (driverName === "claudeAgent") {
          const wake = yield* send(
            sourceThreadId,
            "Background task finished",
            "completed",
            "agent",
            "provider",
          );
          assert.notInclude(wake.text, "Since your last turn:");
          const projection = yield* orchestrator.getThreadProjection(sourceThreadId);
          assert.isEmpty(
            projection.providerTurns.find((turn) => turn.runAttemptId === wake.attemptId)
              ?.inlineContextIds ?? [],
          );
        }
        assert.include(
          (yield* send(sourceThreadId, "Any updates?")).text,
          "Since your last turn: #1484 was closed without merging.",
        );
        assert.notInclude(
          (yield* send(sourceThreadId, "Anything else?")).text,
          "Since your last turn:",
        );
        yield* sync("open");
        yield* sync("closed");
        yield* sync("open");
        assert.notInclude(
          (yield* send(sourceThreadId, "After reopening?")).text,
          "Since your last turn:",
        );
        yield* orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make("watch-next-turn-pr"),
          threadId: sourceThreadId,
          ...key,
          watching: true,
        });
        yield* sync("merged");
        assert.notInclude(
          (yield* send(sourceThreadId, "While watched?")).text,
          "Since your last turn:",
        );
        yield* sync("open");
        const watched = yield* orchestrator.getThreadProjection(sourceThreadId);
        const eventSink = yield* EventSink.EventSinkV2;
        // Persist the retained-watch state that the watch reactor handles on settlement.
        yield* eventSink.write({
          events: [
            {
              id: EventId.make("settle-with-retained-watch"),
              type: "thread.settled",
              threadId: sourceThreadId,
              occurredAt: yield* DateTime.now,
              payload: {
                ...watched.thread,
                settledOverride: "settled",
                settledAt: yield* DateTime.now,
              },
            },
          ],
        });
        const beforeSettledSync = yield* orchestrator.getThreadProjection(sourceThreadId);
        assert.isDefined(beforeSettledSync.thread.pullRequests?.[0]?.watch);
        yield* sync("merged");
        const afterSettledSync = yield* orchestrator.getThreadProjection(sourceThreadId);
        assert.equal(afterSettledSync.runs.length, beforeSettledSync.runs.length);
        assert.equal(afterSettledSync.thread.settledOverride, "settled");
        assert.include(
          (yield* send(sourceThreadId, "After settling while watched?")).text,
          "Since your last turn: #1484 was merged on 2026-11-15 at 14:08 UTC.",
        );
        assert.notInclude(
          (yield* send(sourceThreadId, "After settled delivery?")).text,
          "Since your last turn:",
        );
        yield* orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make("unwatch-next-turn-pr"),
          threadId: sourceThreadId,
          ...key,
          watching: false,
        });
        yield* sync("open");
        yield* sync("merged");
        assert.include(
          (yield* send(sourceThreadId, "After merging?")).text,
          "Since your last turn: #1484 was merged on 2026-11-15 at 14:08 UTC.",
        );
        assert.notInclude(
          (yield* send(sourceThreadId, "After delivery?")).text,
          "Since your last turn:",
        );
        if (driverName !== "codex") return;
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("fork"),
          sourceThreadId,
          targetThreadId: forkThreadId,
          sourcePoint: { type: "run", runId: RunId.make(source.runId) },
          createdBy: "user",
          creationSource: "web",
        });

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

        const command = yield* send(forkThreadId, "/goal ship the fix", "failed");
        assert.equal(command.text, "/goal ship the fix", "a provider command is sent unprefixed");

        // An agent sending into a fork it created, as t3_thread_send does.
        const accepted = yield* send(forkThreadId, "One more time", "completed", "agent");
        assert.include(accepted.text, FORK_NOTE);

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
  );

it.effect.each(["codex", "claudeAgent"] as const)(
  "delivers fork and linked PR context on prompted %s turns",
  contextDelivery,
);
