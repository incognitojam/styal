import { DurableObject } from "cloudflare:workers";
import { checkLimit, checkRpc, migrate, summarize } from "./storage.ts";

export const inventoryMigrations = [
  "CREATE TABLE object_references (kind TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY(kind, name))",
];
export class InventoryObject extends DurableObject<unknown> {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      migrate(ctx.storage, inventoryMigrations);
    });
  }
  async register(request: {
    version: number;
    references: readonly { kind: string; name: string }[];
  }) {
    checkRpc(request.version);
    checkLimit(request.references.length);
    this.ctx.storage.transactionSync(() => {
      for (const ref of request.references)
        this.ctx.storage.sql.exec(
          "INSERT OR IGNORE INTO object_references VALUES (?, ?)",
          ref.kind,
          ref.name,
        );
    });
  }
  async list(request: { version: number; kind: string; after: string; limit: number }) {
    checkRpc(request.version);
    checkLimit(request.limit);
    return this.ctx.storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM object_references WHERE kind = ? AND name > ? ORDER BY name LIMIT ?",
        request.kind,
        request.after,
        request.limit,
      )
      .toArray();
  }
  async inventory(request: { version: number }) {
    checkRpc(request.version);
    return {
      version: request.version,
      schemaVersion: inventoryMigrations.length,
      tables: [
        summarize(
          "object_references",
          this.ctx.storage.sql.exec("SELECT kind, name FROM object_references ORDER BY kind, name"),
        ),
      ],
    };
  }
}
