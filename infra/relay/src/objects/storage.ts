import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

export function migrate(storage: DurableObjectStorage, migrations: readonly string[]) {
  return storage.transactionSync(() => {
    const sql = storage.sql;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS relay_object_schema (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL)",
    );
    const version =
      sql
        .exec<{ version: number }>("SELECT version FROM relay_object_schema WHERE singleton = 1")
        .toArray()[0]?.version ?? 0;
    if (version > migrations.length)
      throw new Error(
        `Relay object schema ${version} is newer than supported ${migrations.length}`,
      );
    for (let i = version; i < migrations.length; i++) {
      sql.exec(migrations[i]!);
      sql.exec(
        "INSERT INTO relay_object_schema VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET version = excluded.version",
        i + 1,
      );
    }
    return migrations.length;
  });
}

export function canonicalJson(value: unknown): string {
  const encoded = JSON.stringify(value, (_key, entry: unknown) =>
    entry !== null && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : entry,
  );
  if (encoded === undefined) throw new Error("Relay object value is not JSON");
  return encoded;
}

export function summarize(table: string, rows: Iterable<unknown>) {
  const hash = sha256.create();
  let count = 0;
  for (const row of rows) {
    hash.update(utf8ToBytes(`${canonicalJson(row)}\n`));
    count++;
  }
  return { table, count, digest: bytesToHex(hash.digest()) };
}

export const RPC_VERSION = 1;
export function checkRpc(version: number) {
  if (version !== RPC_VERSION)
    throw new Error(`Relay object RPC version ${version} is unsupported; expected ${RPC_VERSION}`);
}
export function checkLimit(limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
    throw new Error("Relay object limit must be between 1 and 1000");
}
