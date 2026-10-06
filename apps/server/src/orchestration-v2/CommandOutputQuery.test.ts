import { describe, it } from "@effect/vitest";
import { EventId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { expect } from "vite-plus/test";

import { layerMemory } from "../persistence/Sqlite.ts";

import { CommandOutputQuery, layer, normalizeCommandOutput } from "./CommandOutputQuery.ts";

const TestLayer = layer.pipe(Layer.provideMerge(layerMemory));
const encodeFixtureJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

describe("normalizeCommandOutput", () => {
  it("returns Codex combined output with its exit code", () => {
    expect(
      normalizeCommandOutput({
        kind: "tool.completed",
        payload: {
          itemType: "command_execution",
          data: {
            item: {
              aggregatedOutput: "stdout line\nstderr line\n",
              exitCode: 7,
            },
          },
        },
      }),
    ).toEqual({
      status: "available",
      output: "stdout line\nstderr line\n",
      stdout: null,
      stderr: null,
      exitCode: 7,
    });
  });

  it("keeps ACP stdout and stderr separate", () => {
    expect(
      normalizeCommandOutput({
        kind: "tool.completed",
        payload: {
          itemType: "command_execution",
          status: "completed",
          data: {
            rawOutput: {
              stdout: "stdout line\n",
              stderr: "stderr line\n",
              exitCode: 2,
            },
          },
        },
      }),
    ).toEqual({
      status: "available",
      output: null,
      stdout: "stdout line\n",
      stderr: "stderr line\n",
      exitCode: 2,
    });
  });

  it("truncates long output in the middle", () => {
    const result = normalizeCommandOutput({
      kind: "tool.completed",
      payload: {
        itemType: "command_execution",
        status: "completed",
        data: {
          item: {
            aggregatedOutput: `start-${"x".repeat(300_000)}-end`,
          },
        },
      },
    });

    expect(result.output).toMatch(/^start-/u);
    expect(result.output).toContain("… output truncated …");
    expect(result.output).toMatch(/-end$/u);
  });
});

it.effect("queries migrated command IDs and retained activity IDs without V1 projections", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const query = yield* CommandOutputQuery;
    const threadId = ThreadId.make("thread:migrated-command");
    const canonicalId = "item:migrated-command";
    const payload = {
      id: canonicalId,
      type: "command_execution",
      status: "completed",
      command: "synthetic-command",
      output: null,
      exitCode: null,
      legacyActivities: [
        {
          id: "activity:started",
          kind: "tool.started",
          payload: { itemType: "command_execution", status: "running" },
        },
        {
          id: "activity:completed",
          kind: "tool.completed",
          payload: {
            itemType: "command_execution",
            status: "completed",
            data: {
              rawOutput: {
                stdout: "retained stdout\n",
                stderr: "retained stderr\n",
                exitCode: 23,
              },
            },
          },
        },
      ],
    };
    yield* sql`
      INSERT INTO orchestration_v2_projection_turn_items (
        turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json
      ) VALUES (
        ${canonicalId}, ${threadId}, 1, 'command_execution', 'completed',
        '2026-01-01T00:00:00Z', ${yield* encodeFixtureJson(payload)}
      )
    `;
    yield* sql`DROP TABLE projection_thread_activities`;
    const expected = {
      status: "available",
      output: null,
      stdout: "retained stdout\n",
      stderr: "retained stderr\n",
      exitCode: 23,
    };
    for (const activityId of [canonicalId, "activity:started", "activity:completed"]) {
      expect(
        yield* query.getCommandOutput({ threadId, activityId: EventId.make(activityId) }),
      ).toEqual(expected);
    }
    expect(
      yield* query.getCommandOutput({
        threadId: ThreadId.make("thread:other"),
        activityId: EventId.make("activity:completed"),
      }),
    ).toEqual({ status: "unavailable", output: null, stdout: null, stderr: null, exitCode: null });
    expect(
      yield* query.getCommandOutput({ threadId, activityId: EventId.make("activity:unknown") }),
    ).toEqual({
      status: "unavailable",
      output: null,
      stdout: null,
      stderr: null,
      exitCode: null,
    });

    // Native output is authoritative, while an omitted exit code can still use
    // the retained provider result. A matching canonical ID wins over aliases.
    const native = {
      ...payload,
      id: "activity:completed",
      output: "canonical output",
      exitCode: 7,
      legacyActivities: [],
    };
    yield* sql`
      INSERT INTO orchestration_v2_projection_turn_items (
        turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json
      ) VALUES (
        'activity:completed', ${threadId}, 2, 'command_execution', 'completed',
        '2026-01-01T00:00:01Z', ${yield* encodeFixtureJson(native)}
      )
    `;
    expect(
      yield* query.getCommandOutput({ threadId, activityId: EventId.make("activity:completed") }),
    ).toEqual({
      status: "available",
      output: "canonical output",
      stdout: null,
      stderr: null,
      exitCode: 7,
    });
    yield* sql`
      UPDATE orchestration_v2_projection_turn_items
      SET payload_json = ${yield* encodeFixtureJson({ ...payload, output: "canonical output" })}
      WHERE turn_item_id = ${canonicalId}
    `;
    expect(
      yield* query.getCommandOutput({ threadId, activityId: EventId.make(canonicalId) }),
    ).toEqual({
      status: "available",
      output: "canonical output",
      stdout: null,
      stderr: null,
      exitCode: 23,
    });
  }).pipe(Effect.provide(TestLayer)),
);
