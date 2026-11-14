import { assert, it } from "@effect/vitest";
import { CommandId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  ACP_REGISTRY_DEFAULT_INSTANCE_ID,
  ACP_REGISTRY_PROVIDER,
} from "@t3tools/provider-acp-registry/testing";
import { makeProviderReplayGate } from "@t3tools/provider-testing/replayGate";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Orchestrator from "./Orchestrator.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { AcpRegistryOrchestratorReplayHarness } from "./Adapters/AcpRegistryAdapterV2.testkit.ts";
import type { AcpReplayTranscript } from "./Adapters/AcpAdapterV2.testkit.ts";

it.live.each(["output", "response"] as const)(
  "retains next-turn messages after ACP rejection and delivers them once on %s acceptance",
  (signal) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace(`next-turn-acp-rejection-${signal}`);
        const replayGate = makeProviderReplayGate(signal === "output" ? ["accepted-response"] : []);
        const request = (method: string) => ({
          type: "expect_outbound" as const,
          frame: { kind: "request", method, params: "<any>" },
        });
        const response = (method: string, result: unknown) => ({
          type: "emit_inbound" as const,
          frame: { kind: "response", method, result },
        });
        const transcript: AcpReplayTranscript = {
          provider: ACP_REGISTRY_PROVIDER,
          protocol: "acp.ndjson-jsonrpc",
          version: "1",
          scenario: "next-turn-rejection",
          entries: [
            request("initialize"),
            response("initialize", {
              protocolVersion: 1,
              agentCapabilities: { loadSession: true },
              authMethods: [],
            }),
            request("session/new"),
            response("session/new", { sessionId: "next-turn-session" }),
            request("session/prompt"),
            {
              type: "emit_inbound",
              frame: {
                kind: "response",
                method: "session/prompt",
                error: { code: -32603, message: "Synthetic prompt rejected" },
              },
            },
            request("session/prompt"),
            ...(signal === "output"
              ? [
                  {
                    type: "emit_inbound" as const,
                    frame: {
                      kind: "notification",
                      method: "session/update",
                      params: {
                        sessionId: "next-turn-session",
                        update: {
                          sessionUpdate: "agent_message_chunk",
                          content: { type: "text", text: "Accepted" },
                        },
                      },
                    },
                  },
                ]
              : []),
            {
              ...response("session/prompt", { stopReason: "end_turn" }),
              label: "accepted-response",
            },
            { type: "runtime_exit", status: "success" },
          ],
        };
        const layer = ProviderReplayHarness.layerWithRegistry(
          { name: "next-turn-acp-rejection" },
          AcpRegistryOrchestratorReplayHarness.makeProviderAdapterRegistryLayer(transcript, {
            replayGate,
          }),
          { runEffectWorker: false },
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = ThreadId.make("thread:next-turn-acp");
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create"),
            threadId,
            projectId: ProjectId.make("project:next-turn-acp"),
            title: "ACP acceptance",
            modelSelection: { instanceId: ACP_REGISTRY_DEFAULT_INSTANCE_ID, model: "default" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
            createdBy: "user",
            creationSource: "web",
          });
          const send = (text: string, waiting = false) =>
            orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(text),
              threadId,
              messageId: MessageId.make(text),
              text,
              attachments: [],
              dispatchMode: { type: waiting ? "next_turn" : "start_immediately" },
              createdBy: "user",
              creationSource: "web",
            });
          const terminal = (status: "failed" | "completed") =>
            orchestrator.streamStoredEventsFrom({ threadId, afterSequence: 0 }).pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "run.updated" && stored.event.payload.status === status,
              ),
              Stream.take(1),
              Stream.runDrain,
            );
          yield* send("Acknowledged", true);
          yield* send("Dismissed", true);
          yield* send("FAIL-START");
          yield* worker.drain();
          yield* terminal("failed");
          let projection = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(
            projection.runs
              .filter((run) => run.withNextTurn && run.status === "queued")
              .map((run) => run.userMessageId),
            ["Acknowledged", "Dismissed"],
          );
          yield* send("Resume");
          yield* worker.drain();
          if (signal === "output") {
            yield* Effect.promise(() => replayGate.waitForReached("accepted-response"));
            yield* orchestrator.streamStoredEventsFrom({ threadId, afterSequence: 0 }).pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "run.updated" &&
                  (stored.event.payload.nextTurnMessageIds?.length ?? 0) === 2,
              ),
              Stream.take(1),
              Stream.runDrain,
            );
            assert.isFalse(
              (yield* orchestrator.getThreadProjection(threadId)).runs.some(
                (run) => run.status === "queued",
              ),
            );
            yield* Effect.sync(() => replayGate.release("accepted-response"));
          }

          yield* orchestrator.streamStoredEventsFrom({ threadId, afterSequence: 0 }).pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "provider-turn.updated" &&
                stored.event.payload.status === "completed",
            ),
            Stream.take(1),
            Stream.runDrain,
          );
          yield* worker.drain();
          projection = yield* orchestrator.getThreadProjection(threadId);
          assert.isFalse(projection.runs.some((run) => run.status === "queued"));
          const delivered = projection.runs.find(
            (run) => run.userMessageId === MessageId.make("Resume"),
          )!;
          assert.deepEqual(delivered.nextTurnMessageIds, [
            MessageId.make("Acknowledged"),
            MessageId.make("Dismissed"),
          ]);
          for (const id of ["Acknowledged", "Dismissed"]) {
            assert.equal(
              projection.messages.filter(
                (message) => message.id === id && message.runId === delivered.id,
              ).length,
              1,
            );
            assert.equal(
              projection.turnItems.filter(
                (item) =>
                  item.type === "user_message" &&
                  item.messageId === id &&
                  item.runId === delivered.id,
              ).length,
              1,
            );
          }
        }).pipe(Effect.provide(layer));
      }),
    ),
);
