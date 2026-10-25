import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Leases persist because a thread may keep a device across turns. An ended lease keeps its row,
 * with `releasing_until` set, until its release hooks succeed or give up, so a crash mid-cleanup
 * resumes it. Repeated identical audit calls coalesce into one row.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS hardware_leases (
      device_id TEXT PRIMARY KEY NOT NULL,
      thread_id TEXT NOT NULL,
      purpose TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      granted_at TEXT NOT NULL,
      last_activity_at TEXT NOT NULL,
      idle_minutes INTEGER NOT NULL,
      hard_expires_at TEXT,
      keep_until_released INTEGER NOT NULL DEFAULT 0,
      release_plan_json TEXT NOT NULL,
      releasing_until TEXT
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS hardware_audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      last_occurred_at TEXT NOT NULL,
      actor TEXT NOT NULL,
      thread_id TEXT,
      event TEXT NOT NULL,
      action TEXT,
      detail_json TEXT NOT NULL,
      repeat_count INTEGER NOT NULL DEFAULT 1
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_hardware_audit_events_device
    ON hardware_audit_events(device_id, id)
  `;
});
