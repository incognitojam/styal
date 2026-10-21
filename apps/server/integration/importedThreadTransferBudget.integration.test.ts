// @effect-diagnostics nodeBuiltinImport:off - Measures a real local HTTP socket.
import * as NodeHttp from "node:http";
import { assert, it } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  EnvironmentId,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION,
  OrchestrationV2ThreadDetailSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { HttpRouter, HttpServer } from "effect/http";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../src/config.ts";
import { layerHttpCompression } from "../src/http.ts";
import * as EventSink from "../src/orchestration-v2/EventSink.ts";
import * as EventStore from "../src/orchestration-v2/EventStore.ts";
import * as OrchestrationHttp from "../src/orchestration-v2/http.ts";
import * as ServerEnvironment from "../src/environment/ServerEnvironment.ts";
import * as LegacyV1ThreadImporter from "../src/orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as ProjectionStore from "../src/orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../src/orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../src/orchestration-v2/ThreadManagementService.ts";
import * as OrchestrationEventStoreLayer from "../src/persistence/OrchestrationEventStore.ts";
import { layerMemory } from "../src/persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../src/project/ProjectEnrichmentService.ts";
import * as ProjectService from "../src/project/ProjectService.ts";
import * as ServerRuntimeStartup from "../src/serverRuntimeStartup.ts";
import { measureHttpGet } from "./NetworkTransferMeasurement.integration.ts";

/**
 * Threads converted from V1 history keep every command's full recorded output in
 * persistence. Clients render only the canonical items, so an imported
 * thread must cost about as much on the wire as its conversation. The upstream transfer
 * report measures native threads only; this guards the imported path.
 */
const THREAD_ID = ThreadId.make("imported-transfer-thread");
const TURNS = 10;
const COMMANDS_PER_TURN = 5;
const OUTPUT_BYTES_PER_COMMAND = 200_000;
// Measured at 5.1 KB on the wire and 87 KB decoded, about 35% under these caps. Shipping
// the 6.7 MB of retained output exceeds them by orders of magnitude.
const BUDGET = {
  snapshotWireBytes: 7_000,
  snapshotDecodedBytes: 115_000,
};

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeThreadSnapshot = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ThreadDetailSnapshot)),
);

const persistence = EventSink.layer.pipe(
  Layer.provideMerge(EventStore.layerFromOrchestrationEventStore),
  Layer.provideMerge(ProjectionStore.layer),
  Layer.provideMerge(OrchestrationEventStoreLayer.layer),
  Layer.provideMerge(layerMemory),
);
// Reads delegate to the real SQL projection, as the runtime does once a transcript is imported.
const management = Layer.unwrap(
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    return Layer.mock(ThreadManagementService.ThreadManagementService)({
      ensureLegacyTranscript: () => Effect.void,
      getThreadSnapshot: (id) => projections.getThreadSnapshot(id).pipe(Effect.orDie),
      getThreadSnapshotWindow: (id, options) =>
        projections.getThreadSnapshotWindow(id, options).pipe(Effect.orDie),
      streamStoredEventsFrom: () => Stream.empty,
    });
  }),
);
const services = management.pipe(
  Layer.provideMerge(LegacyV1ThreadImporter.layer),
  Layer.provideMerge(ProjectStore.layer),
  Layer.provideMerge(Layer.mock(ProjectService.ProjectService)({})),
  Layer.provideMerge(Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({})),
  Layer.provideMerge(persistence),
  Layer.provideMerge(Layer.succeed(ServerConfig.ServerConfig, {} as never)),
  Layer.provideMerge(Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({})),
);
class TransferApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.orchestration,
) {}
const auth = Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
  effect.pipe(
    Effect.provideService(EnvironmentAuthenticatedPrincipal, {
      sessionId: AuthSessionId.make("imported-transfer-session"),
      subject: "imported-transfer-test",
      method: "browser-session-cookie",
      scopes: new Set([AuthOrchestrationReadScope]),
    }),
  ),
);
const routes = HttpApiBuilder.layer(TransferApi).pipe(
  Layer.provide(OrchestrationHttp.layer),
  Layer.provide(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("imported-transfer-test")),
    }),
  ),
  Layer.provide(auth),
  Layer.provide(layerHttpCompression),
  Layer.provide(NodeHttpPlatform.layer),
);

/** A V1 thread whose commands recorded large output, as the V1 read model stored it. */
const seedLegacyThread = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const at = (seconds: number) =>
    DateTime.formatIso(DateTime.makeUnsafe(Date.UTC(2026, 0, 1, 0, 0, seconds)));
  yield* sql`
    INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES ('imported-transfer-project', 'Imported transfer', '/synthetic/project', '[]', ${at(0)}, ${at(0)})
  `;
  yield* sql`
    INSERT INTO projection_threads (thread_id, project_id, title, runtime_mode, interaction_mode, created_at, updated_at)
    VALUES (${THREAD_ID}, 'imported-transfer-project', 'Imported transfer', 'full-access', 'default', ${at(0)}, ${at(0)})
  `;
  let sequence = 0;
  for (let turn = 0; turn < TURNS; turn++) {
    const turnId = `turn:${turn}`;
    const start = turn * 60;
    yield* sql`
      INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, attachments_json, is_streaming, created_at, updated_at)
      VALUES (${`user:${turn}`}, ${THREAD_ID}, ${turnId}, 'user', ${`Request ${turn}`}, '[]', 0, ${at(start)}, ${at(start)}),
        (${`assistant:${turn}`}, ${THREAD_ID}, ${turnId}, 'assistant', ${`Answer ${turn}`}, '[]', 0, ${at(start + 50)}, ${at(start + 50)})
    `;
    for (let command = 0; command < COMMANDS_PER_TURN; command++) {
      const toolCallId = `call:${turn}:${command}`;
      const output = `${turn}:${command} `.repeat(OUTPUT_BYTES_PER_COMMAND / 6);
      for (const [kind, status] of [
        ["tool.started", "inProgress"],
        ["tool.completed", "completed"],
      ] as const) {
        sequence += 1;
        const payload = {
          itemType: "command_execution",
          toolCallId,
          status,
          data: {
            item: {
              command: `run step ${command}`,
              ...(status === "completed" ? { aggregatedOutput: output, exitCode: 0 } : {}),
            },
          },
        };
        yield* sql`
          INSERT INTO styal_legacy_v1_thread_activities (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at, sequence)
          VALUES (${`${toolCallId}:${kind}`}, ${THREAD_ID}, ${turnId}, 'tool', ${kind}, 'Ran command',
            ${encodeJson(payload)}, ${at(start + 1 + command * 9 + (status === "completed" ? 8 : 0))}, ${sequence})
        `;
      }
    }
  }
});

it.live("keeps imported V1 thread history within the client transfer budget", () =>
  Effect.gen(function* () {
    yield* seedLegacyThread;
    const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
    yield* importer.reconcileShells;
    yield* importer.ensureTranscript(THREAD_ID);

    // Persistence keeps every command's full recorded output on the converted item.
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const durable = yield* projections.getThreadProjection(THREAD_ID);
    const outputs = durable.turnItems.flatMap((item) =>
      item.type === "command_execution" ? [item.output?.length ?? 0] : [],
    );
    assert.equal(outputs.length, TURNS * COMMANDS_PER_TURN);
    assert.isTrue(outputs.every((length) => length >= OUTPUT_BYTES_PER_COMMAND * 0.6));

    const context = yield* Effect.context<Layer.Success<typeof services>>();
    const server = yield* Layer.build(
      HttpRouter.serve(routes, { disableListenLog: true }).pipe(
        Layer.provide(Layer.succeedContext(context)),
        Layer.provideMerge(NodeHttpServer.layer(NodeHttp.createServer, { port: 0 })),
      ),
    );
    const address = Context.get(server, HttpServer.HttpServer).address;
    if (!("port" in address)) return yield* Effect.die("Expected TCP server");
    const snapshot = yield* measureHttpGet({
      url: `http://127.0.0.1:${address.port}/api/orchestration/threads/${THREAD_ID}`,
      headers: { [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION) },
    });
    const body = Buffer.from(snapshot.decodedBody).toString();
    assert.equal(snapshot.status, 200, body);
    const decoded = yield* decodeThreadSnapshot(body);
    assert.equal(
      decoded.projection.turnItems.filter((item) => item.type === "command_execution").length,
      TURNS * COMMANDS_PER_TURN,
    );
    assert.notInclude(body, "legacyActivities");

    assert.isAtMost(snapshot.wireBytes, BUDGET.snapshotWireBytes, "snapshot wire bytes");
    assert.isAtMost(
      snapshot.decodedBodyBytes,
      BUDGET.snapshotDecodedBytes,
      "snapshot decoded bytes",
    );
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(services, NodeServices.layer))),
);
