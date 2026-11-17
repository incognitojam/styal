import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Keep these predicates aligned with ProjectionStore's open report question queries.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_messages_report_key_idx
    ON orchestration_v2_projection_messages(thread_id, json_extract(payload_json, '$.report.key'))
    WHERE json_extract(payload_json, '$.report.key') IS NOT NULL
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_messages_report_answer_idx
    ON orchestration_v2_projection_messages(thread_id, json_extract(payload_json, '$.reportAnswer.messageId'))
    WHERE json_extract(payload_json, '$.reportAnswer.messageId') IS NOT NULL
  `;
});
