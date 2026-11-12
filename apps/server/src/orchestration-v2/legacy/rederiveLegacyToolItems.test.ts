import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runAllMigrations } from "../../persistence/ForkMigrations.ts";
import { readHistoryRewriteFence } from "../historyRewriteFence.ts";
import { rederiveLegacyToolItems } from "./rederiveLegacyToolItems.ts";

const at = "2026-01-01T00:00:00.000Z";
const commandPayload = {
  itemType: "command_execution",
  title: "Command run",
  status: "completed",
  detail: "Bash: python3 calc.py",
  data: {
    toolName: "Bash",
    input: { command: "python3 calc.py", description: "Run calc" },
    result: { type: "tool_result", content: "3", is_error: false },
  },
};
const readPayload = {
  itemType: "dynamic_tool_call",
  title: "Tool call",
  status: "completed",
  data: {
    toolName: "Read",
    input: { file_path: "/synthetic/calc.py" },
    result: { type: "tool_result", content: "1\tdef add(a, b):" },
  },
};
const seed = Effect.fn("seed")(function* (sql: SqlClient.SqlClient) {
  yield* runAllMigrations();
  const originals: string[] = [];
  for (const [index, key] of [
    "command",
    "read",
    "kept",
    "missing",
    "native",
    "other",
    "pruned",
    "custom",
    "active",
  ].entries()) {
    const id = key === "native" || key === "other" ? key : `import:v1:activity:thread-1:${key}`;
    const payload = key === "read" ? readPayload : commandPayload;
    const item = {
      id,
      threadId: "thread-1",
      ordinal: index + 1,
      runId: key === "active" ? "run-1" : null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      type: key === "read" ? "dynamic_tool" : "command_execution",
      status: "completed",
      title: payload.title,
      startedAt: at,
      completedAt: at,
      updatedAt: at,
      input:
        key === "read"
          ? readPayload.data
          : key === "custom"
            ? "custom command"
            : commandPayload.detail,
      ...(key === "read" ? { toolName: payload.title } : {}),
      ...(key === "kept" ? { output: "canonical", exitCode: 7 } : {}),
      legacyActivities: [
        {
          id: key,
          tone: "tool",
          kind: "tool.completed",
          summary: "Tool call",
          turnId: null,
          createdAt: at,
        },
      ],
    };
    const json = JSON.stringify(item);
    originals.push(json);
    yield* sql`INSERT INTO orchestration_v2_projection_turn_items
      (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json)
      VALUES (${id}, 'thread-1', ${item.runId}, ${item.ordinal}, ${item.type}, 'completed', ${at}, ${json})`;
    if (key !== "pruned")
      yield* sql`INSERT INTO orchestration_events
      (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json, application_event_version)
      VALUES (${`migration:v1:history:thread-1:item:${id}`}, 'thread', 'thread-1', ${item.ordinal}, 'turn-item.updated', ${at}, 'server', ${json}, '{}', 2)`;
    if (key !== "missing")
      yield* sql`INSERT INTO styal_legacy_v1_thread_activities
      (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at, sequence)
      VALUES (${key}, 'thread-1', NULL, 'tool', 'tool.completed', 'Tool call', ${JSON.stringify(payload)}, ${at}, ${index})`;
  }
  return originals;
});

describe("rederiveLegacyToolItems", () => {
  it.effect(
    "repairs missing tool fields, preserves unrelated data, and handles pruned events and repeats",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const originals = yield* seed(sql);
        const before = yield* readHistoryRewriteFence(sql);
        assert.deepEqual(yield* rederiveLegacyToolItems(sql), { threads: 1, items: 5, failed: 0 });
        const rows = yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM orchestration_v2_projection_turn_items ORDER BY ordinal`;
        const items = rows.map((row) => JSON.parse(row.payload_json));
        assert.equal(items[0].input, "python3 calc.py");
        assert.equal(items[0].output, "3");
        assert.equal(items[1].toolName, "Read");
        assert.deepEqual(items[1].input, readPayload.data.input);
        assert.equal(items[1].output, "1\tdef add(a, b):");
        assert.equal(items[2].output, "canonical");
        assert.equal(items[2].exitCode, 7);
        for (const index of [3, 4, 5, 8]) assert.equal(rows[index]?.payload_json, originals[index]);
        assert.equal(items[6].output, "3");
        assert.equal(items[7].input, "custom command");
        for (const [index, item] of items.entries()) {
          const {
            input: _oldInput,
            output: _oldOutput,
            toolName: _oldName,
            ...oldRest
          } = JSON.parse(originals[index]!);
          const { input: _input, output: _output, toolName: _name, ...rest } = item;
          assert.deepEqual(rest, oldRest);
        }
        const events = yield* sql<{
          payload_json: string;
          ordinal: number;
        }>`SELECT e.payload_json, p.ordinal FROM orchestration_events e JOIN orchestration_v2_projection_turn_items p ON e.event_id = 'migration:v1:history:thread-1:item:' || p.turn_item_id`;
        for (const event of events)
          assert.equal(event.payload_json, rows[event.ordinal - 1]?.payload_json);
        const undo = yield* sql<{
          turn_item_id: string;
          previous_fields_json: string;
          absent_fields_json: string;
        }>`SELECT turn_item_id, previous_fields_json, absent_fields_json FROM styal_legacy_v1_rederived_items ORDER BY turn_item_id`;
        assert.equal(undo.length, 5);
        // Restoring the recorded fields gives back each original item.
        for (const entry of undo) {
          const index = rows.findIndex(
            (row) => JSON.parse(row.payload_json).id === entry.turn_item_id,
          );
          const restored = JSON.parse(rows[index]!.payload_json);
          for (const field of JSON.parse(entry.absent_fields_json)) delete restored[field];
          Object.assign(restored, JSON.parse(entry.previous_fields_json));
          assert.deepEqual(restored, JSON.parse(originals[index]!));
        }
        const fence = yield* readHistoryRewriteFence(sql);
        assert.isAbove(fence, before);
        assert.deepEqual(yield* rederiveLegacyToolItems(sql), { threads: 0, items: 0, failed: 0 });
        assert.equal(yield* readHistoryRewriteFence(sql), fence);
        assert.deepEqual(
          yield* sql`SELECT payload_json FROM orchestration_v2_projection_turn_items ORDER BY ordinal`,
          rows,
        );
        yield* sql`INSERT INTO orchestration_v2_projection_turn_items
          (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json)
          VALUES ('import:v1:activity:thread-1:unreadable', 'thread-1', NULL, 100, 'command_execution', 'completed', ${at}, '{"id":"unreadable"}')`;
        yield* sql`DELETE FROM orchestration_v2_projection_metadata WHERE projection_name = 'legacy-tool-items-rederived'`;
        assert.deepEqual(yield* rederiveLegacyToolItems(sql), { threads: 1, items: 0, failed: 0 });
        assert.equal(yield* readHistoryRewriteFence(sql), fence);
        assert.deepEqual(
          yield* sql`SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE ordinal = 100`,
          [{ payload_json: '{"id":"unreadable"}' }],
        );
        assert.deepEqual(
          yield* sql`SELECT turn_item_id, previous_fields_json, absent_fields_json FROM styal_legacy_v1_rederived_items ORDER BY turn_item_id`,
          undo,
        );
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
  it.effect("cleans up the undo copy after thirty days and retains the done marker", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed(sql);
      yield* rederiveLegacyToolItems(sql);
      const marker =
        yield* sql`SELECT * FROM orchestration_v2_projection_metadata WHERE projection_name = 'legacy-tool-items-rederived'`;
      yield* TestClock.adjust("29 days");
      yield* rederiveLegacyToolItems(sql);
      assert.lengthOf(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'styal_legacy_v1_rederived_items'`,
        1,
      );
      yield* TestClock.adjust("1 day");
      yield* rederiveLegacyToolItems(sql);
      assert.lengthOf(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'styal_legacy_v1_rederived_items'`,
        0,
      );
      yield* rederiveLegacyToolItems(sql);
      assert.deepEqual(
        yield* sql`SELECT * FROM orchestration_v2_projection_metadata WHERE projection_name = 'legacy-tool-items-rederived'`,
        marker,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
  it.effect("skips an item that fails, withholds the marker and still moves the fence", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed(sql);
      const before = yield* readHistoryRewriteFence(sql);
      const failing = yield* rederiveLegacyToolItems(sql).pipe(
        Effect.provideService(Statement.CurrentTransformer, (statement) => {
          const [query, params] = statement.compile();
          if (
            query.includes("WHERE turn_item_id =") &&
            params.includes("import:v1:activity:thread-1:read")
          )
            return Effect.die(new Error("unreadable item"));
          return Effect.succeed(statement);
        }),
      );
      assert.deepEqual(failing, { threads: 1, items: 4, failed: 1 });
      assert.lengthOf(
        yield* sql`SELECT 1 FROM orchestration_v2_projection_metadata WHERE projection_name = 'legacy-tool-items-rederived'`,
        0,
      );
      const fence = yield* readHistoryRewriteFence(sql);
      assert.isAbove(fence, before);
      assert.deepEqual(yield* rederiveLegacyToolItems(sql), { threads: 1, items: 1, failed: 0 });
      assert.isAbove(yield* readHistoryRewriteFence(sql), fence);
      assert.lengthOf(
        yield* sql`SELECT 1 FROM orchestration_v2_projection_metadata WHERE projection_name = 'legacy-tool-items-rederived'`,
        1,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
  it.effect("creates no undo table and leaves the fence alone when nothing changes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runAllMigrations();
      const fence = yield* readHistoryRewriteFence(sql);
      assert.deepEqual(yield* rederiveLegacyToolItems(sql), { threads: 0, items: 0, failed: 0 });
      assert.lengthOf(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'styal_legacy_v1_rederived_items'`,
        0,
      );
      assert.equal(yield* readHistoryRewriteFence(sql), fence);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
