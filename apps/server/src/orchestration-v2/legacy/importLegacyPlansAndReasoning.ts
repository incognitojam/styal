import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as EventSink from "../EventSink.ts";
import { readLegacyTextItems } from "./LegacyTextItems.ts";
import { orderLegacyHistory } from "./orderLegacyHistory.ts";

const DONE_MARKER = "legacy-plans-reasoning-imported";
const WRITE_BATCH_SIZE = 100;

export const importLegacyPlansAndReasoning = Effect.fn("importLegacyPlansAndReasoning")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const sink = yield* EventSink.EventSinkV2;
    const done =
      yield* sql`SELECT 1 FROM orchestration_v2_projection_metadata WHERE projection_name = ${DONE_MARKER}`;
    if (done.length > 0) return { threads: 0, reasoning: 0, plans: 0 };
    const threads = yield* sql<{ readonly thread_id: string }>`
    SELECT thread_id FROM orchestration_v2_legacy_imports
    WHERE transcript_imported_at IS NOT NULL ORDER BY thread_id
  `;
    let reasoning = 0;
    let plans = 0;
    for (const row of threads) {
      const threadId = ThreadId.make(row.thread_id);
      const counts = yield* Effect.gen(function* () {
        const events = yield* readLegacyTextItems(sql, threadId);
        const existing = yield* sql<{ readonly turn_item_id: string }>`
        SELECT turn_item_id FROM orchestration_v2_projection_turn_items
        WHERE thread_id = ${threadId} AND
          (turn_item_id LIKE 'migration:v1:turn-item:reasoning:%' OR turn_item_id LIKE 'migration:v1:turn-item:plan:%')
      `;
        const ids = new Set(existing.map((item) => item.turn_item_id));
        const missing = events.filter(
          (event) => event.type === "turn-item.updated" && !ids.has(event.payload.id),
        );
        // Short transactions keep foreground writes from waiting behind a long thread.
        for (let start = 0; start < missing.length; start += WRITE_BATCH_SIZE) {
          yield* sql.withTransaction(
            sink.write({ events: missing.slice(start, start + WRITE_BATCH_SIZE) }),
          );
        }
        // Always ordered, so a pass interrupted between writing and ordering recovers.
        yield* sql.withTransaction(orderLegacyHistory(sql, [threadId]));
        return {
          reasoning: missing.filter(
            (event) => event.type === "turn-item.updated" && event.payload.type === "reasoning",
          ).length,
          plans: missing.filter(
            (event) => event.type === "turn-item.updated" && event.payload.type === "proposed_plan",
          ).length,
        };
      });
      reasoning += counts.reasoning;
      plans += counts.plans;
      yield* Effect.yieldNow;
    }
    // Include additions committed before an interrupted pass so its retry still invalidates caches.
    const added = yield* sql<{ readonly found: number }>`
    SELECT 1 AS found FROM orchestration_v2_projection_turn_items
    WHERE turn_item_id LIKE 'migration:v1:turn-item:reasoning:%'
      OR turn_item_id LIKE 'migration:v1:turn-item:plan:%' LIMIT 1
  `;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        if (added[0]?.found === 1) {
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
        }
        yield* sql`
          INSERT INTO orchestration_v2_projection_metadata (
            projection_name, schema_version, last_sequence, updated_at
          )
          VALUES (${DONE_MARKER}, 1, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
          ON CONFLICT(projection_name) DO NOTHING
        `;
      }),
    );
    const result = { threads: threads.length, reasoning, plans };
    yield* Effect.logInfo("Imported legacy plans and reasoning", result);
    return result;
  },
);
