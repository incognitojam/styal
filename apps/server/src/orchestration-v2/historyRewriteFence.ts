import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Migrations that rewrite stored history in place reserve an event sequence as a fence,
 * because clients resume cached threads by replaying only later events. Thread resumes from
 * before the fence get a snapshot, and thread snapshots report at least the fence as their
 * sequence so a refreshed cache resumes normally afterwards. Fork migration 8 shows how to
 * set it.
 */
const HISTORY_REWRITE_FENCE = "history-rewrite-fence";

export const readHistoryRewriteFence = (sql: SqlClient.SqlClient) =>
  sql<{ readonly last_sequence: number }>`
    SELECT last_sequence
    FROM orchestration_v2_projection_metadata
    WHERE projection_name = ${HISTORY_REWRITE_FENCE}
  `.pipe(Effect.map((rows) => rows[0]?.last_sequence ?? 0));
