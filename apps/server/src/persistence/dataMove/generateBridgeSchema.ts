// @effect-diagnostics nodeBuiltinImport:off globalJsonInEffect:off -- Offline synthetic schema generation.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeZlib from "node:zlib";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runAllMigrations } from "../ForkMigrations.ts";
import { isSqliteStatistics, schemaHash, type Definition } from "./schema.ts";
import source from "./source.json" with { type: "json" };
import objects from "./sourceObjects.json" with { type: "json" };

const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "styal-bridge-schema-"));
try {
  const definitions: Definition[] = [];
  for (const family of ["preflight", "installed-history"]) {
    const filename = NodePath.join(directory, family + ".sqlite");
    NodeFS.writeFileSync(
      filename,
      NodeZlib.gunzipSync(
        NodeFS.readFileSync(new URL(`./fixtures/${family}.sqlite.gz`, import.meta.url)),
      ),
    );
    await Effect.runPromise(
      runAllMigrations({ offlineDataMove: true }).pipe(
        Effect.provide(
          Layer.merge(
            NodeSqliteClient.layer({ filename, readerWorker: false, writerWorker: false }),
            Logger.layer([], { mergeWithExisting: false }),
          ),
        ),
        Effect.scoped,
      ),
    );
    const db = new NodeSqlite.DatabaseSync(filename);
    try {
      for (const row of db
        .prepare(
          "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name",
        )
        .all()) {
        const entry: Definition = {
          type: String(row.type),
          name: String(row.name),
          table: String(row.tbl_name),
          hash: schemaHash(row.sql),
        };
        if (isSqliteStatistics(entry)) continue;
        const pinned = source.definitions.find((d) => d.name === entry.name);
        if (pinned && "optional" in pinned && pinned.optional) entry.optional = true;
        const base = definitions.find((d) => d.name === entry.name);
        if (!base) {
          if (family !== "preflight" && !entry.optional)
            throw new Error("Unexpected installed-history object");
          definitions.push(entry);
        } else if (base.hash !== entry.hash) {
          if (
            !Object.hasOwn(objects.installedHistory, entry.name) ||
            base.type !== entry.type ||
            base.table !== entry.table
          )
            throw new Error("Unexpected installed-history definition");
          base.variants = [{ label: "installed-history", hash: entry.hash }];
        }
      }
    } finally {
      db.close();
    }
  }
  definitions.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  NodeFS.writeFileSync(
    new URL("./bridgeSchema.json", import.meta.url),
    JSON.stringify(definitions, null, 2) + "\n",
  );
} finally {
  NodeFS.rmSync(directory, { recursive: true, force: true });
}
