/* oxlint-disable t3code/namespace-node-imports -- Temporary standalone runner instrumentation. */
import { DatabaseSync, StatementSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { threadId, Worker } from "node:worker_threads";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
const directory = process.env.EVENT_PRUNING_SQL_TRACE_DIR;
if (directory) {
  fs.mkdirSync(directory, { recursive: true });
  // Node's CJS eval workers skip ESM preloads, so instrument their source explicitly.
  createRequire(import.meta.url)("node:worker_threads").Worker = class extends Worker {
    constructor(source, options) {
      super(
        options?.eval && typeof source === "string"
          ? `require(${JSON.stringify(fileURLToPath(import.meta.url))});\n${source}`
          : source,
        options,
      );
    }
  };
  syncBuiltinESMExports();
  const target = path.join(directory, `${process.pid}-${threadId}.jsonl`);
  const statements = new WeakMap();
  const phaseOf = (sql) =>
    /\bwal_checkpoint\s*\(\s*(PASSIVE|FULL|RESTART|TRUNCATE)\s*\)/i.test(sql)
      ? "checkpoint"
      : /^\s*DELETE FROM orchestration_events\b/i.test(sql)
        ? "delete SQL"
        : null;
  const pending = new WeakMap();
  const measure = (database, sql, operation) => {
    const phase = phaseOf(sql);
    const start = phase ? performance.timeOrigin + performance.now() : null;
    try {
      return operation();
    } finally {
      if (phase) {
        const rows = pending.get(database) ?? [];
        rows.push({
          phase,
          start,
          end: performance.timeOrigin + performance.now(),
          pid: process.pid,
          threadId,
        });
        pending.set(database, rows);
      }
      // Flush after COMMIT, so trace I/O never extends the server's write transaction.
      if (pending.has(database) && !database.isTransaction) {
        fs.appendFileSync(
          target,
          pending
            .get(database)
            .map((row) => JSON.stringify(row))
            .join("\n") + "\n",
        );
        pending.delete(database);
      }
    }
  };
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (sql, ...args) {
    const statement = prepare.call(this, sql, ...args);
    statements.set(statement, { sql, database: this });
    return statement;
  };
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql, ...args) {
    return measure(this, sql, () => exec.call(this, sql, ...args));
  };
  for (const method of ["run", "get", "all"]) {
    const execute = StatementSync.prototype[method];
    StatementSync.prototype[method] = function (...args) {
      const { sql, database } = statements.get(this) ?? {};
      return database
        ? measure(database, sql, () => execute.apply(this, args))
        : execute.apply(this, args);
    };
  }
}
