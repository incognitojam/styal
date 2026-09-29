import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layerMemory())("051_ProjectionThreadLatestMessageAt", (it) => {
  it.effect("backfills the last message time without using later thread updates", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 50 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          created_at, updated_at
        ) VALUES (
          'thread-1', 'project-1', 'Synthetic thread',
          '{"instanceId":"codex","model":"gpt-5"}', 'full-access',
          '2026-01-01T10:00:00.000Z', '2026-01-01T10:30:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at
        ) VALUES
          ('user-1', 'thread-1', 'user', 'Prompt', 0,
            '2026-01-01T10:00:00.000Z', '2026-01-01T10:00:00.000Z'),
          ('assistant-1', 'thread-1', 'assistant', 'Reply', 0,
            '2026-01-01T10:10:00.000Z', '2026-01-01T10:13:00.000Z')
      `;

      yield* runMigrations({ toMigrationInclusive: 51 });

      const rows = yield* sql<{ readonly latestMessageAt: string | null }>`
        SELECT latest_message_at AS "latestMessageAt"
        FROM projection_threads
        WHERE thread_id = 'thread-1'
      `;
      assert.deepEqual(rows, [{ latestMessageAt: "2026-01-01T10:13:00.000Z" }]);
    }),
  );
});
