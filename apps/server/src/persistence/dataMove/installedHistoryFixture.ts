// @effect-diagnostics nodeBuiltinImport:off -- Synthetic offline fixture generation.
import type * as NodeSqlite from "node:sqlite";
import objects from "./sourceObjects.json" with { type: "json" };

export function installHistoryVariant(db: NodeSqlite.DatabaseSync) {
  db.exec("PRAGMA foreign_keys=OFF; BEGIN");
  for (const [table, sql] of Object.entries(objects.installedHistory)) {
    const rows = db.prepare(`SELECT * FROM ${table}`).all();
    const dependents = db
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE tbl_name=? AND type!='table' AND sql IS NOT NULL",
      )
      .all(table);
    db.exec(`DROP TABLE ${table}`);
    db.exec(sql);
    for (const row of rows) {
      const columns = Object.keys(row);
      db.prepare(
        `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
      ).run(...Object.values(row));
    }
    for (const entry of dependents) db.exec(String(entry.sql));
  }
  db.exec(objects.optionalTables.styal_legacy_v1_rederived_items);
  db.prepare(`INSERT INTO styal_legacy_v1_rederived_items
    (turn_item_id,thread_id,previous_fields_json,absent_fields_json,rederived_at)
    VALUES(?,?,?,?,?)`).run(
    "synthetic-retired-item",
    "ordinary",
    '{"input":"synthetic"}',
    '["output"]',
    "2026-01-01T00:00:00.000Z",
  );
  db.exec("ANALYZE; DELETE FROM sqlite_stat1; COMMIT; PRAGMA foreign_keys=ON");
}
