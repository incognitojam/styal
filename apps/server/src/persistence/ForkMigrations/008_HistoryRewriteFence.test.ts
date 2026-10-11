import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { readHistoryRewriteFence } from "../../orchestration-v2/historyRewriteFence.ts";
import { runForkMigrations } from "../ForkMigrations.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("008_HistoryRewriteFence", (it) => {
  it.effect("fences every event stored before the migration", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* runForkMigrations({ toMigrationInclusive: 7 });
      assert.equal(yield* readHistoryRewriteFence(sql), 0);
      for (const version of [1, 2, 3]) {
        yield* sql`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
            actor_kind, payload_json, metadata_json, application_event_version
          ) VALUES (
            ${`event-${version}`}, 'thread', 'thread-1', ${version}, 'turn-item.updated',
            '2026-01-01T00:00:00.000Z', 'server', '{}', '{}', 2
          )
        `;
      }

      yield* runForkMigrations({ toMigrationInclusive: 8 });

      assert.equal(yield* readHistoryRewriteFence(sql), 3);
    }),
  );
});
