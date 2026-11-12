import { assert, it } from "@effect/vitest";
import { EventId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as EventSink from "../EventSink.ts";
import * as EventStore from "../EventStore.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import { readHistoryRewriteFence } from "../historyRewriteFence.ts";
import * as LegacyV1ThreadImporter from "./LegacyV1ThreadImporter.ts";
import { importLegacyPlansAndReasoning } from "./importLegacyPlansAndReasoning.ts";

const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const sink = EventSink.layer.pipe(Layer.provideMerge(stores));
const layer = LegacyV1ThreadImporter.layer.pipe(Layer.provideMerge(sink));
const at = "2026-01-01T00:00:00.000Z";

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
  const sink = yield* EventSink.EventSinkV2;
  yield* sql`
    INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES ('project:test', 'Synthetic project', '/synthetic/project', '[]', ${at}, ${at})
  `;
  for (const id of ["thread:a", "thread:b", "thread:empty"]) {
    yield* sql`
      INSERT INTO projection_threads (thread_id, project_id, title, runtime_mode, interaction_mode, created_at, updated_at)
      VALUES (${id}, 'project:test', 'Synthetic thread', 'full-access', 'default', ${at}, ${at})
    `;
    yield* sql`
      INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
      VALUES (${`${id}:message`}, ${id}, 'user', 'Question', 0, ${at}, ${at})
    `;
  }
  yield* importer.reconcileShells;
  for (const id of ["thread:a", "thread:b", "thread:empty"])
    yield* importer.ensureTranscript(ThreadId.make(id));
  for (const id of ["thread:a", "thread:b"]) {
    const later = "2026-01-02T00:00:00.000Z";
    yield* sql`
      INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
      VALUES (${`${id}:reasoning`}, ${id}, 'turn:test', 'reasoning', 'Thinking', 0, ${later}, ${later})
    `;
    for (const [index, markdown] of ["Old", "Latest"].entries()) {
      yield* sql`
        INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version,
          event_type, occurred_at, actor_kind, payload_json, metadata_json, application_event_version)
        VALUES (${`${id}:plan:${index}`}, 'thread', ${id}, ${index + 100}, 'thread.proposed-plan-upserted',
          ${later}, 'server', ${JSON.stringify({ threadId: id, proposedPlan: { id: `${id}:plan`, turnId: null, planMarkdown: markdown, createdAt: later, updatedAt: later } })}, '{}', 1)
      `;
    }
  }
  // A malformed V1 plan event is skipped instead of failing the thread.
  yield* sql`
    INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version,
      event_type, occurred_at, actor_kind, payload_json, metadata_json, application_event_version)
    VALUES ('thread:a:plan:malformed', 'thread', 'thread:a', 200, 'thread.proposed-plan-upserted',
      '2026-01-02T00:00:00.000Z', 'server', '{"threadId":"thread:a","proposedPlan":{"id":"broken"}}', '{}', 1)
  `;
  for (const [index, id] of ["native:first", "native:second"].entries()) {
    const date = DateTime.makeUnsafe("2026-01-03T00:00:00.000Z");
    yield* sink.write({
      events: [
        {
          id: EventId.make(`event:${id}`),
          type: "turn-item.updated",
          threadId: ThreadId.make("thread:a"),
          occurredAt: date,
          payload: {
            id: TurnItemId.make(id),
            threadId: ThreadId.make("thread:a"),
            runId: null,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: index + 2,
            status: "completed",
            title: null,
            startedAt: date,
            completedAt: date,
            updatedAt: date,
            type: "reasoning",
            text: `Native content ${index}`,
            streaming: false,
          },
        },
      ],
    });
  }
});

it.effect(
  "backfills once, preserves native content and order, and resumes interrupted transactions",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed;
      const before = yield* sql<{
        readonly turn_item_id: string;
        readonly ordinal: number;
        readonly payload_json: string;
      }>`
      SELECT turn_item_id, ordinal, payload_json FROM orchestration_v2_projection_turn_items ORDER BY thread_id, ordinal
    `;
      const fenceBefore = yield* readHistoryRewriteFence(sql);
      const interrupted = yield* importLegacyPlansAndReasoning().pipe(
        Effect.provideService(Statement.CurrentTransformer, (statement) => {
          const [query, params] = statement.compile();
          if (query.includes("FROM projection_thread_messages") && params.includes("thread:b"))
            return Effect.interrupt;
          return Effect.succeed(statement);
        }),
        Effect.exit,
      );
      assert.isTrue(Exit.hasInterrupts(interrupted));
      assert.deepEqual(
        yield* sql`SELECT projection_name FROM orchestration_v2_projection_metadata WHERE projection_name = 'legacy-plans-reasoning-imported'`,
        [],
      );
      assert.deepEqual(yield* importLegacyPlansAndReasoning(), {
        threads: 3,
        reasoning: 1,
        plans: 1,
      });
      const fence = yield* readHistoryRewriteFence(sql);
      assert.isAbove(fence, fenceBefore);
      assert.deepEqual(yield* importLegacyPlansAndReasoning(), {
        threads: 0,
        reasoning: 0,
        plans: 0,
      });
      assert.equal(yield* readHistoryRewriteFence(sql), fence);
      const after = yield* sql<{
        readonly turn_item_id: string;
        readonly ordinal: number;
        readonly payload_json: string;
      }>`
      SELECT turn_item_id, ordinal, payload_json FROM orchestration_v2_projection_turn_items ORDER BY thread_id, ordinal
    `;
      assert.equal(after.length, before.length + 4);
      assert.deepEqual(
        after.filter((row) => row.turn_item_id.includes("thread:empty")),
        before.filter((row) => row.turn_item_id.includes("thread:empty")),
      );
      const native = after.filter((row) => row.turn_item_id.startsWith("native:"));
      assert.deepEqual(
        native.map((row) => [row.turn_item_id, row.ordinal]),
        [
          ["native:first", 4],
          ["native:second", 5],
        ],
      );
      for (const row of native) {
        const previous = before.find((old) => old.turn_item_id === row.turn_item_id)!;
        assert.deepEqual(JSON.parse(row.payload_json), {
          ...JSON.parse(previous.payload_json),
          ordinal: row.ordinal,
        });
        assert.deepEqual(
          yield* sql`SELECT ordinal FROM orchestration_v2_turn_item_positions WHERE turn_item_id = ${row.turn_item_id}`,
          [{ ordinal: row.ordinal }],
        );
        const events = yield* sql<{
          readonly payload_json: string;
        }>`SELECT payload_json FROM orchestration_events WHERE event_id = ${`event:${row.turn_item_id}`}`;
        assert.deepEqual(JSON.parse(events[0]!.payload_json), JSON.parse(row.payload_json));
      }
      const plans = after.filter((row) =>
        row.turn_item_id.startsWith("migration:v1:turn-item:plan:"),
      );
      assert.deepEqual(
        plans.map((row) => JSON.parse(row.payload_json).markdown),
        ["Latest", "Latest"],
      );
      assert.deepEqual(yield* sql`SELECT * FROM orchestration_v2_projection_plans`, []);
      // Simulate losing the marker after a committed pass: deterministic ids still prevent duplicate events.
      const eventsBefore = yield* sql`SELECT COUNT(*) AS count FROM orchestration_events`;
      yield* sql`DELETE FROM orchestration_v2_projection_metadata WHERE projection_name = 'legacy-plans-reasoning-imported'`;
      assert.deepEqual(yield* importLegacyPlansAndReasoning(), {
        threads: 3,
        reasoning: 0,
        plans: 0,
      });
      assert.deepEqual(
        yield* sql`SELECT COUNT(*) AS count FROM orchestration_events`,
        eventsBefore,
      );
    }).pipe(Effect.provide(layer)),
);
