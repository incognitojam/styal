import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_orchestration_events_setup_worktree_request
    ON orchestration_events(json_extract(payload_json, '$.setupScript.worktreePath'), sequence DESC)
    WHERE application_event_version = 2 AND aggregate_kind = 'thread'
      AND event_type = 'turn-item.updated'
      AND json_extract(payload_json, '$.status') = 'pending'
      AND substr(json_extract(payload_json, '$.setupScript.terminalId'), 1, 6) = 'setup-'
  `;
});
