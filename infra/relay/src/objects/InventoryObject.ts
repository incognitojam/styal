import { DurableObject } from "cloudflare:workers";
import { checkLimit, checkRpc, migrate, summarize } from "./storage.ts";

export const inventoryMigrations = [
  "CREATE TABLE object_references (kind TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY(kind, name))",
  `CREATE TABLE replay_references (name TEXT PRIMARY KEY, epoch INTEGER NOT NULL, retiring INTEGER NOT NULL);
   INSERT INTO replay_references SELECT name, row_number() OVER (ORDER BY name), 0 FROM object_references WHERE kind = 'replay';
   CREATE TABLE replay_epoch_counter (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), epoch INTEGER NOT NULL);
   INSERT INTO replay_epoch_counter VALUES (1, (SELECT coalesce(max(epoch), 0) FROM replay_references))`,
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
      for (const ref of request.references) {
        if (ref.kind === "replay") {
          const previous = this.ctx.storage.sql
            .exec<{ retiring: number }>(
              "SELECT retiring FROM replay_references WHERE name = ?",
              ref.name,
            )
            .toArray()[0];
          if (!previous || previous.retiring) {
            const { epoch } = this.ctx.storage.sql
              .exec<{ epoch: number }>(
                "UPDATE replay_epoch_counter SET epoch = epoch + 1 RETURNING epoch",
              )
              .one();
            this.ctx.storage.sql.exec(
              "INSERT INTO replay_references VALUES (?, ?, 0) ON CONFLICT(name) DO UPDATE SET epoch = excluded.epoch, retiring = 0",
              ref.name,
              epoch,
            );
          }
        }
        this.ctx.storage.sql.exec(
          "INSERT OR IGNORE INTO object_references VALUES (?, ?)",
          ref.kind,
          ref.name,
        );
      }
    });
  }

  async replayReferences(request: { version: number; after: string; limit: number }) {
    checkRpc(request.version);
    checkLimit(request.limit);
    return this.ctx.storage.sql
      .exec<{ name: string; epoch: number; retiring: number }>(
        "SELECT name, epoch, retiring FROM replay_references WHERE name > ? ORDER BY name LIMIT ?",
        request.after,
        request.limit,
      )
      .toArray();
  }

  async unregister(request: { version: number; name: string; epoch: number }) {
    checkRpc(request.version);
    return this.ctx.storage.transactionSync(() => {
      const current = this.ctx.storage.sql
        .exec<{ epoch: number }>("SELECT epoch FROM replay_references WHERE name = ?", request.name)
        .toArray()[0];
      if (current?.epoch !== request.epoch) return false;
      this.ctx.storage.sql.exec(
        "DELETE FROM object_references WHERE kind = 'replay' AND name = ?",
        request.name,
      );
      // Keep interrupted replay retirement discoverable until deletion or re-registration finishes.
      this.ctx.storage.sql.exec(
        "UPDATE replay_references SET retiring = 1 WHERE name = ?",
        request.name,
      );
      return true;
    });
  }

  async finishReplayRetirement(request: { version: number; name: string; epoch: number }) {
    checkRpc(request.version);
    this.ctx.storage.sql.exec(
      "DELETE FROM replay_references WHERE name = ? AND epoch = ? AND retiring = 1",
      request.name,
      request.epoch,
    );
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
        summarize(
          "replay_references",
          this.ctx.storage.sql.exec(
            "SELECT name, epoch, retiring FROM replay_references ORDER BY name",
          ),
        ),
        summarize(
          "replay_epoch_counter",
          this.ctx.storage.sql.exec("SELECT epoch FROM replay_epoch_counter"),
        ),
      ],
    };
  }
}
