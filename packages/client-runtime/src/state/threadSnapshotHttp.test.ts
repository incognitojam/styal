import { expect, it } from "@effect/vitest";
import { afterEach, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ThreadId,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";
import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createThreadSnapshotCommands } from "./threadSnapshotHttp.ts";
const decodeProjection = Schema.decodeUnknownSync(
  Schema.toCodecJson(OrchestrationV2ThreadProjection),
);
const THREAD_ID = ThreadId.make("synthetic-full-history");
const NOW = "2026-06-20T00:00:00.000Z";
afterEach(() => vi.unstubAllGlobals());
const SNAPSHOT = {
  snapshotSequence: 9,
  projection: {
    thread: {
      createdBy: "user",
      creationSource: "web",
      id: String(THREAD_ID),
      projectId: "project-1",
      title: "Full fallback thread",
      providerInstanceId: "codex",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: String(THREAD_ID),
      },
      forkedFrom: null,
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      deletedAt: null,
      settledOverride: null,
      settledAt: null,
    },
    runs: [],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: NOW,
  },
};

const makeHarness = Effect.fn("fullSnapshot.makeHarness")(function* () {
  const ids = [EnvironmentId.make("primary"), EnvironmentId.make("remote")];
  const supervisors = new Map<
    EnvironmentId,
    EnvironmentSupervisor.EnvironmentSupervisor["Service"]
  >();
  const websocketReads: string[] = [];
  for (const id of ids) {
    const target = new PrimaryConnectionTarget({
      environmentId: id,
      label: id,
      httpBaseUrl: `https://${id}.example.test`,
      wsBaseUrl: `wss://${id}.example.test`,
    });
    const prepared: PreparedConnection = {
      environmentId: id,
      label: id,
      httpBaseUrl: target.httpBaseUrl,
      socketUrl: target.wsBaseUrl,
      httpAuthorization: null,
      target,
    };
    supervisors.set(id, {
      target,
      prepared: yield* SubscriptionRef.make(Option.some(prepared)),
      session: yield* SubscriptionRef.make(
        Option.some({
          client: {
            [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: () => {
              websocketReads.push(id);
              return Effect.succeed(decodeProjection(SNAPSHOT.projection));
            },
          },
        } as unknown as RpcSession),
      ),
    } as EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  }
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, {
      run: (id, effect) =>
        Effect.provideService(
          effect,
          EnvironmentSupervisor.EnvironmentSupervisor,
          supervisors.get(id)!,
        ),
    } as EnvironmentRegistry.EnvironmentRegistry["Service"]),
  );
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  return { ids, registry, commands: createThreadSnapshotCommands(runtime), websocketReads };
});
it.effect(
  "reads fresh complete history for the requested environment independent of bounded state",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const requests: string[] = [];
        vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
          const url = String(input);
          requests.push(url);
          expect(url).not.toContain("/bounded");
          return Response.json({
            ...SNAPSHOT,
            projection: {
              ...SNAPSHOT.projection,
              thread: { ...SNAPSHOT.projection.thread, title: `Full read ${requests.length}` },
            },
          });
        });
        for (const [index, environmentId] of [h.ids[0]!, h.ids[1]!, h.ids[0]!].entries()) {
          const result = yield* Effect.promise(() =>
            h.commands.fetchFull.run(h.registry, { environmentId, input: { threadId: THREAD_ID } }),
          );
          expect(result._tag).toBe("Success");
          if (result._tag === "Success" && Option.isSome(result.value))
            expect(result.value.value.thread.title).toBe(`Full read ${index + 1}`);
          expect(requests[index]).toBe(
            `https://${environmentId}.example.test/api/orchestration/threads/${THREAD_ID}`,
          );
        }
        expect(h.websocketReads).toEqual([]);
      }),
    ),
);
it.effect("falls back to the full socket projection when the HTTP route is unavailable", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness();
      vi.stubGlobal("fetch", async () => new Response("Unavailable", { status: 503 }));
      const result = yield* Effect.promise(() =>
        h.commands.fetchFull.run(h.registry, {
          environmentId: h.ids[1]!,
          input: { threadId: THREAD_ID },
        }),
      );
      expect(result._tag).toBe("Success");
      if (result._tag === "Success") expect(Option.isSome(result.value)).toBe(true);
      expect(h.websocketReads).toEqual([h.ids[1]]);
    }),
  ),
);
