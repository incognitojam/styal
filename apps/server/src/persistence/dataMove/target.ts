// @effect-diagnostics nodeBuiltinImport:off - Offline SQLite tooling needs synchronous Node file and descriptor operations.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import * as NodePath from "node:path";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { InventoryRefusal } from "./errors.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as Logger from "effect/Logger";
import { isLivePath } from "./safety.ts";
import { runMigrations } from "../Migrations.ts";

type UpstreamMigration = ReturnType<typeof runMigrations>;
const runTargetMigrations = Effect.fn("DataMove.migrateTarget")(function* () {
  const filename = NodePath.resolve(import.meta.dirname, "../ForkMigrations.ts");
  if (!NodeFS.existsSync(filename)) {
    yield* runMigrations();
    return;
  }
  const module = yield* Effect.tryPromise({
    try: () =>
      import(NodeURL.pathToFileURL(filename).href) as Promise<{
        runAllMigrations: () => Effect.Effect<
          unknown,
          Effect.Error<UpstreamMigration>,
          Effect.Services<UpstreamMigration>
        >;
      }>,
    catch: (cause) => new InventoryRefusal({ category: "target-migration-loader-failed", cause }),
  });
  yield* module.runAllMigrations();
});

// Only SqlClient and Reactivity are built. SqlitePersistence would also initialize legacy state.
export const createTarget = Effect.fn("DataMove.createTarget")(function* (filename: string) {
  yield* Effect.try({
    try: () => {
      const parent = NodeFS.realpathSync(NodePath.dirname(filename));
      if (isLivePath(NodePath.resolve(filename)) || isLivePath(parent))
        throw new Error("live-target-refused");
      NodeFS.closeSync(
        NodeFS.openSync(NodePath.join(parent, NodePath.basename(filename)), "wx", 0o600),
      );
    },
    catch: (cause) => new InventoryRefusal({ category: "target-initialization-failed", cause }),
  });
  yield* runTargetMigrations().pipe(
    Effect.provide(
      Layer.merge(
        NodeSqliteClient.layer({ filename, readerWorker: false, writerWorker: false }),
        Logger.layer([], { mergeWithExisting: false }),
      ),
    ),
  );
});

export const inspectTarget = Effect.fn("DataMove.inspectTarget")(function* () {
  return yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runTargetMigrations();
    const definitions =
      yield* sql`SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name`;
    const columns: Record<string, ReadonlyArray<Record<string, unknown>>> = {};
    for (const entry of definitions.filter((entry) => entry.type === "table")) {
      columns[String(entry.name)] = yield* sql.unsafe<Record<string, unknown>>(
        `PRAGMA table_xinfo("${String(entry.name).replaceAll('"', '""')}")`,
      );
    }
    return {
      definitions,
      columns,
      ledger:
        yield* sql`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`,
      metadata:
        yield* sql`SELECT projection_name, schema_version FROM orchestration_v2_projection_metadata`,
    };
  }).pipe(
    Effect.provide(
      Layer.merge(
        NodeSqliteClient.layer({ filename: ":memory:", readerWorker: false, writerWorker: false }),
        Logger.layer([], { mergeWithExisting: false }),
      ),
    ),
  );
});
