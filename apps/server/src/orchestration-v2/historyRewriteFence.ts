import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

/**
 * History-rewriting migrations reserve an event sequence as a fence because clients resume
 * cached threads by replaying later events only. Resumes from before the fence get a snapshot,
 * and snapshots report at least the fence so a refreshed cache resumes normally. Fork migration
 * 8 sets it.
 */
const HISTORY_REWRITE_FENCE = "history-rewrite-fence";

export const readHistoryRewriteFence = (sql: SqlClient.SqlClient) =>
  sql<{ readonly last_sequence: number }>`
    SELECT last_sequence
    FROM orchestration_v2_projection_metadata
    WHERE projection_name = ${HISTORY_REWRITE_FENCE}
  `.pipe(Effect.map((rows) => rows[0]?.last_sequence ?? 0));
