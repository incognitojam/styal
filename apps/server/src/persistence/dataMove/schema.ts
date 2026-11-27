// @effect-diagnostics nodeBuiltinImport:off -- Pinned offline schema fingerprints.
import * as NodeCrypto from "node:crypto";

export type Definition = {
  type: string;
  name: string;
  table: string;
  hash: string;
  optional?: boolean;
  variants?: readonly { label?: string; hash: string }[];
};

export const schemaHash = (sql: unknown) =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(sql)).digest("hex");

export const isSqliteStatistics = (entry: { type: string; name: string }) =>
  entry.type === "table" && entry.name.startsWith("sqlite_stat");

export function compareSchema(actual: readonly Definition[], expected: readonly Definition[]) {
  const differences: Record<string, number> = {};
  for (const pinned of expected) {
    const found = actual.find((entry) => entry.name === pinned.name);
    if (!found) {
      if (!pinned.optional) differences[`${pinned.type} / ${pinned.name} / missing`] = 1;
    } else if (
      found.type !== pinned.type ||
      found.table !== pinned.table ||
      (found.hash !== pinned.hash && !pinned.variants?.some((v) => v.hash === found.hash))
    ) {
      differences[`${pinned.type} / ${pinned.name} / definition`] = 1;
    }
  }
  for (const entry of actual) {
    if (!isSqliteStatistics(entry) && !expected.some((pinned) => pinned.name === entry.name))
      differences["unrecognised-schema-object"] =
        (differences["unrecognised-schema-object"] ?? 0) + 1;
  }
  return differences;
}
