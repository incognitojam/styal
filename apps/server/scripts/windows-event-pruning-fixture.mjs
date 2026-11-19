/* oxlint-disable t3code/namespace-node-imports -- Temporary standalone runner experiment. */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Sqlite from "../src/persistence/Sqlite.ts";
import * as ProjectionStore from "../src/orchestration-v2/ProjectionStore.ts";
import * as SqlClient from "effect/sql/SqlClient";
import { ThreadId } from "@t3tools/contracts";
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

const [mode, file, size = "small"] = process.argv.slice(2);
if (!file) throw new Error("explicit database path required");
if (mode === "seed") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // The release launch fixture is public synthetic data, not a developer's database.
  fs.copyFileSync(
    "scripts/fixtures/desktop-launch/statev2.sqlite",
    file,
    fs.constants.COPYFILE_EXCL,
  );
  await Effect.runPromise(
    Effect.void.pipe(
      Effect.provide(Sqlite.layerFromPath(file)),
      Effect.provide(NodeServices.layer),
    ),
  );
  const db = new DatabaseSync(file);
  const original = db
    .prepare("SELECT * FROM orchestration_v2_projection_threads ORDER BY thread_id LIMIT 1")
    .get();
  const columns = Object.keys(original);
  const clone = db.prepare(
    `INSERT INTO orchestration_v2_projection_threads (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
  );
  for (let i = 0; i < 10; i++) {
    const id = `synthetic-thread-${i}`;
    const payload = JSON.parse(String(original.payload_json));
    payload.id = id;
    payload.title = `Synthetic old thread ${i}`;
    payload.lineage = { rootThreadId: id, parentThreadId: null, relationshipToParent: null };
    clone.run(
      ...columns.map((key) =>
        key === "thread_id"
          ? id
          : key === "payload_json"
            ? JSON.stringify(payload)
            : key === "title"
              ? payload.title
              : original[key],
      ),
    );
  }
  const threads = db
    .prepare("SELECT thread_id FROM orchestration_v2_projection_threads ORDER BY thread_id")
    .all();
  for (const thread of threads)
    for (let i = 1; i <= 3; i++) {
      const id = `synthetic-turn-${thread.thread_id}-${i}`;
      const payload = {
        id,
        providerThreadId: `synthetic-provider-${thread.thread_id}`,
        nodeId: `synthetic-node-${thread.thread_id}`,
        runAttemptId: null,
        nativeTurnRef: null,
        ordinal: i,
        status: "completed",
        startedAt: "2020-01-01T00:00:00.000Z",
        completedAt: "2020-01-01T00:01:00.000Z",
      };
      db.prepare(
        `INSERT INTO orchestration_v2_projection_provider_turns (provider_turn_id,thread_id,provider_thread_id,node_id,run_attempt_id,ordinal,status,started_at,completed_at,payload_json) VALUES (?,?,?,?,NULL,?,'completed',?,?,?)`,
      ).run(
        id,
        thread.thread_id,
        payload.providerThreadId,
        payload.nodeId,
        i,
        payload.startedAt,
        payload.completedAt,
        JSON.stringify(payload),
      );
    }
  const insert = db.prepare(`INSERT INTO orchestration_events
    (event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json,application_event_version)
    VALUES (?, 'thread', ?, ?, 'thread.updated', '2020-01-01T00:00:00.000Z', 'server', ?, '{}', ?)`);
  const count = size === "large" ? 16000 : 2000;
  const payload = JSON.stringify({
    title: "Synthetic previous title",
    output: "Synthetic command output line.\n".repeat(size === "large" ? 650 : 60),
  });
  db.exec("BEGIN");
  for (let i = 0; i < count; i++)
    insert.run(
      `experiment:${i}`,
      threads[i % threads.length].thread_id,
      10000 + i,
      payload,
      i < 100 ? 1 : 2,
    );
  const imported = threads[0].thread_id;
  db.prepare(
    `INSERT OR REPLACE INTO orchestration_v2_legacy_imports (thread_id,source_updated_at,shell_imported_at,transcript_imported_at,imported_message_count) VALUES (?, '2020-01-01','2020-01-01','2020-01-01',0)`,
  ).run(imported);
  db.exec(`INSERT OR REPLACE INTO orchestration_v2_projection_metadata (projection_name,schema_version,last_sequence,updated_at)
    VALUES ('thread-projections',1,(SELECT MAX(sequence) FROM orchestration_events),'2020-01-01'),
    ('event-log-prune-mark',1,(SELECT MAX(sequence) FROM orchestration_events),'2020-01-01'),
    ('legacy-plans-reasoning-imported',1,0,'2020-01-01'); COMMIT; PRAGMA wal_checkpoint(TRUNCATE)`);
  console.log(
    JSON.stringify({
      fixture: size,
      bytes: fs.statSync(file).size,
      threads: threads.length,
      events: db.prepare("SELECT COUNT(*) n FROM orchestration_events").get(),
      tables: db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'orchestration_v2_projection_%'",
        )
        .all()
        .map((r) => ({
          name: r.name,
          rows: db.prepare(`SELECT COUNT(*) n FROM "${r.name}"`).get().n,
        })),
    }),
  );
  db.close();
} else if (mode === "dump") {
  const database = Sqlite.layerFromPath(file);
  const layer = ProjectionStore.layer.pipe(
    Layer.provideMerge(database),
    Layer.provide(NodeServices.layer),
  );
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const rows =
        yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads ORDER BY thread_id`;
      const projections = [];
      for (const row of rows)
        projections.push(yield* store.getThreadSnapshot(ThreadId.make(String(row.thread_id))));
      return projections;
    }).pipe(Effect.provide(layer)),
  );
  console.log(
    JSON.stringify({
      dumpHash: createHash("sha256").update(JSON.stringify(result)).digest("hex"),
      threads: result.length,
    }),
  );
} else throw new Error("unknown mode");
