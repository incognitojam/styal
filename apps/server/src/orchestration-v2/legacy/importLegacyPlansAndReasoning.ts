import { ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as EventSink from "../EventSink.ts";
import { readLegacyTextItems, writeLegacyTextItems } from "./LegacyTextItems.ts";
import { LEGACY_PLANS_REASONING_IMPORTED } from "./legacyPlansReasoningMarker.ts";
import { orderLegacyHistory } from "./orderLegacyHistory.ts";

// Set with each change and cleared once the fence moves, so an interrupted pass still moves it.
const FENCE_PENDING = "legacy-plans-reasoning-fence-pending";
const WRITE_BATCH_SIZE = 100;

const markFencePending = (sql: SqlClient.SqlClient) => sql`
  INSERT INTO orchestration_v2_projection_metadata (projection_name, schema_version, last_sequence, updated_at)
  VALUES (${FENCE_PENDING}, 1, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT(projection_name) DO NOTHING
`;

/** Adds the V1 plans and reasoning that threads imported before the importer kept them lack. */
export const importLegacyPlansAndReasoning = Effect.fn("importLegacyPlansAndReasoning")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const sink = yield* EventSink.EventSinkV2;
    const done = yield* sql`
      SELECT 1 FROM orchestration_v2_projection_metadata
      WHERE projection_name = ${LEGACY_PLANS_REASONING_IMPORTED}
    `;
    if (done.length > 0) return { threads: 0, reasoning: 0, plans: 0, failed: 0 };
    const v1ThreadEvents = yield* sql<{ readonly found: number }>`
      SELECT 1 AS found FROM orchestration_events
      WHERE application_event_version = 1 AND aggregate_kind = 'thread' LIMIT 1
    `;
    if (v1ThreadEvents.length === 0) {
      yield* Effect.logInfo(
        "No V1 thread events remain in this database, so no V1 proposed plans can be imported",
      );
    }
    const threads = yield* sql<{ readonly thread_id: string }>`
      SELECT thread_id FROM orchestration_v2_legacy_imports
      WHERE transcript_imported_at IS NOT NULL ORDER BY thread_id
    `;
    let reasoning = 0;
    let plans = 0;
    let failed = 0;
    for (const row of threads) {
      const threadId = ThreadId.make(row.thread_id);
      const counts = yield* Effect.gen(function* () {
        const events = yield* readLegacyTextItems(sql, threadId);
        const existing = yield* sql<{ readonly turn_item_id: string }>`
          SELECT turn_item_id FROM orchestration_v2_projection_turn_items
          WHERE thread_id = ${threadId} AND (
            turn_item_id LIKE 'migration:v1:turn-item:reasoning:%'
            OR turn_item_id LIKE 'migration:v1:turn-item:plan:%')
        `;
        const ids = new Set(existing.map((item) => item.turn_item_id));
        const missing = events.filter(
          (event) => event.type === "turn-item.updated" && !ids.has(event.payload.id),
        );
        // Short transactions keep foreground writes from waiting behind a long thread.
        for (let start = 0; start < missing.length; start += WRITE_BATCH_SIZE) {
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* writeLegacyTextItems(
                sql,
                sink,
                threadId,
                missing.slice(start, start + WRITE_BATCH_SIZE),
              );
              yield* markFencePending(sql);
            }),
          );
        }
        // Always ordered, so a pass interrupted between writing and ordering recovers.
        yield* sql.withTransaction(
          Effect.gen(function* () {
            if ((yield* orderLegacyHistory(sql, [threadId])) > 0) yield* markFencePending(sql);
          }),
        );
        return {
          reasoning: missing.filter(
            (event) => event.type === "turn-item.updated" && event.payload.type === "reasoning",
          ).length,
          plans: missing.filter(
            (event) => event.type === "turn-item.updated" && event.payload.type === "proposed_plan",
          ).length,
        };
      }).pipe(
        // One unreadable thread must not stop the rest; the pass retries it on a later start.
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterrupts(cause),
          (cause) =>
            Effect.logWarning("Importing legacy plans and reasoning skipped a thread", {
              threadId,
              cause,
            }).pipe(Effect.as(undefined)),
        ),
      );
      if (counts === undefined) failed += 1;
      else {
        reasoning += counts.reasoning;
        plans += counts.plans;
      }
      yield* Effect.yieldNow;
    }
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const pending = yield* sql`
          SELECT 1 FROM orchestration_v2_projection_metadata WHERE projection_name = ${FENCE_PENDING}
        `;
        if (pending.length > 0) {
          yield* sql`
            UPDATE sqlite_sequence
            SET seq = MAX(seq, (SELECT COALESCE(MAX(sequence), 0) FROM orchestration_events)) + 1
            WHERE name = 'orchestration_events'
          `;
          yield* sql`
            INSERT INTO orchestration_v2_projection_metadata (
              projection_name, schema_version, last_sequence, updated_at
            )
            VALUES (
              'history-rewrite-fence', 1,
              (SELECT seq FROM sqlite_sequence WHERE name = 'orchestration_events'),
              strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            )
            ON CONFLICT(projection_name) DO UPDATE SET
              last_sequence = excluded.last_sequence,
              updated_at = excluded.updated_at
          `;
          yield* sql`
            DELETE FROM orchestration_v2_projection_metadata WHERE projection_name = ${FENCE_PENDING}
          `;
        }
        if (failed === 0) {
          yield* sql`
            INSERT INTO orchestration_v2_projection_metadata (
              projection_name, schema_version, last_sequence, updated_at
            )
            VALUES (${LEGACY_PLANS_REASONING_IMPORTED}, 1, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            ON CONFLICT(projection_name) DO NOTHING
          `;
        }
      }),
    );
    const result = { threads: threads.length, reasoning, plans, failed };
    yield* Effect.logInfo("Imported legacy plans and reasoning", result);
    return result;
  },
);
