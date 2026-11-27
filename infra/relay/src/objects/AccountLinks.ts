import type { RelayManagedEndpoint } from "@t3tools/contracts/relay";
import { canonicalJson, checkRpc, summarize } from "./storage.ts";

export interface LinkIntent {
  userId: string;
  environmentId: string;
  environmentPublicKey: string;
  label: string;
  endpoint: RelayManagedEndpoint;
  notificationsEnabled: boolean;
  liveActivitiesEnabled: boolean;
  managedTunnelsEnabled: boolean;
  createdByDeviceId: string | null;
  credential?: { credentialId: string; tokenHash: string };
}
export interface StoredLink extends LinkIntent {
  operationId: string;
  generation: number;
  createdAt: string;
  updatedAt: string;
  holdWebhooksWhileOffline: boolean;
  published: boolean;
  revoked: boolean;
}
export const linkMigration = `CREATE TABLE account_links (environment_id TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE link_operations (operation_id TEXT PRIMARY KEY, intent TEXT NOT NULL, generation INTEGER NOT NULL);`;
export type LinkCommand =
  | { kind: "get"; environmentId: string }
  | { kind: "list" }
  | { kind: "begin"; intent: LinkIntent; operationId: string; now: string; hold: boolean }
  | { kind: "publish"; environmentId: string; operationId: string; generation: number }
  | { kind: "revoke"; environmentId: string; operationId: string; now: string };

export function links(
  storage: DurableObjectStorage,
  request: { version: number; command: LinkCommand },
) {
  checkRpc(request.version);
  return storage.transactionSync(() => {
    const sql = storage.sql;
    const c = request.command;
    const read = (environmentId: string): StoredLink | null => {
      const row = sql
        .exec<{ value: string }>(
          "SELECT value FROM account_links WHERE environment_id = ?",
          environmentId,
        )
        .toArray()[0];
      return row ? JSON.parse(row.value) : null;
    };
    const save = (link: StoredLink) => {
      sql.exec(
        "INSERT INTO account_links VALUES (?, ?) ON CONFLICT(environment_id) DO UPDATE SET value = excluded.value",
        link.environmentId,
        canonicalJson(link),
      );
      return link;
    };
    switch (c.kind) {
      case "list":
        return {
          link: null,
          links: sql
            .exec<{ value: string }>("SELECT value FROM account_links ORDER BY environment_id")
            .toArray()
            .map((r) => JSON.parse(r.value) as StoredLink),
        };
      case "get":
        return { link: read(c.environmentId) };
      case "begin": {
        const old = read(c.intent.environmentId);
        const intent = canonicalJson(c.intent);
        const op = sql
          .exec<{ intent: string; generation: number }>(
            "SELECT intent, generation FROM link_operations WHERE operation_id = ?",
            c.operationId,
          )
          .toArray()[0];
        if (op) {
          if (op.intent !== intent) throw new Error("Link intent mismatch");
          if (
            !old ||
            old.generation !== op.generation ||
            old.operationId !== c.operationId ||
            old.revoked
          )
            throw new Error("Link operation superseded");
          return { link: old };
        }
        const generation = (old?.generation ?? 0) + 1;
        sql.exec("INSERT INTO link_operations VALUES (?, ?, ?)", c.operationId, intent, generation);
        return {
          link: save({
            ...c.intent,
            operationId: c.operationId,
            generation,
            createdAt: old?.createdAt ?? c.now,
            updatedAt: c.now,
            holdWebhooksWhileOffline: c.hold,
            published: false,
            revoked: false,
          }),
        };
      }
      case "publish": {
        const link = read(c.environmentId);
        if (
          !link ||
          link.revoked ||
          link.generation !== c.generation ||
          link.operationId !== c.operationId
        )
          throw new Error("Link publication superseded");
        return { link: link.published ? link : save({ ...link, published: true }) };
      }
      case "revoke": {
        const link = read(c.environmentId);
        const intent = canonicalJson({ kind: "revoke", environmentId: c.environmentId });
        const op = sql
          .exec<{ intent: string; generation: number }>(
            "SELECT intent, generation FROM link_operations WHERE operation_id = ?",
            c.operationId,
          )
          .toArray()[0];
        if (op) {
          if (op.intent !== intent) throw new Error("Unlink intent mismatch");
          return {
            link: link?.generation === op.generation && link.revoked ? link : null,
            changed: false,
          };
        }
        if (!link || link.revoked) {
          sql.exec(
            "INSERT INTO link_operations VALUES (?, ?, ?)",
            c.operationId,
            intent,
            link?.generation ?? 0,
          );
          return { link, changed: false };
        }
        sql.exec(
          "INSERT INTO link_operations VALUES (?, ?, ?)",
          c.operationId,
          intent,
          link.generation + 1,
        );
        return {
          link: save({
            ...link,
            operationId: c.operationId,
            generation: link.generation + 1,
            revoked: true,
            published: false,
            updatedAt: c.now,
          }),
          changed: true,
        };
      }
    }
  });
}
export function linkInventory(storage: DurableObjectStorage) {
  return ["account_links", "link_operations"].map((table) =>
    summarize(table, storage.sql.exec(`SELECT * FROM ${table} ORDER BY 1`)),
  );
}
