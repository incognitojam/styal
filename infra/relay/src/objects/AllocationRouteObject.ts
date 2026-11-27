import { DurableObject } from "cloudflare:workers";
import { canonicalJson, checkRpc, migrate, summarize } from "./storage.ts";

export interface AllocationOwner {
  userId: string;
  environmentId: string;
}
export const allocationRouteMigrations = [
  "CREATE TABLE allocation_route(singleton INTEGER PRIMARY KEY CHECK(singleton=1), epoch INTEGER NOT NULL, owner TEXT); CREATE TABLE allocation_generations(owner TEXT PRIMARY KEY, generation INTEGER NOT NULL, epoch INTEGER NOT NULL)",
];
export class AllocationRouteObject extends DurableObject<unknown> {
  private initialized() {
    const exists =
      this.ctx.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE name = 'allocation_route'")
        .toArray().length > 0;
    if (exists) migrate(this.ctx.storage, allocationRouteMigrations);
    return exists;
  }
  async resolve(request: { version: number }) {
    checkRpc(request.version);
    if (!this.initialized()) return null;
    const row = this.ctx.storage.sql
      .exec<{ epoch: number; owner: string | null }>("SELECT epoch, owner FROM allocation_route")
      .toArray()[0];
    return row?.owner
      ? { epoch: row.epoch, owner: JSON.parse(row.owner) as AllocationOwner }
      : null;
  }
  async claim(request: {
    version: number;
    owner: AllocationOwner;
    generation: number;
    epoch?: number;
  }) {
    checkRpc(request.version);
    migrate(this.ctx.storage, allocationRouteMigrations);
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const old = sql
        .exec<{ epoch: number; owner: string | null }>("SELECT epoch, owner FROM allocation_route")
        .toArray()[0];
      const owner = canonicalJson(request.owner);
      const fence = sql
        .exec<{ generation: number; epoch: number }>(
          "SELECT generation, epoch FROM allocation_generations WHERE owner = ?",
          owner,
        )
        .toArray()[0];
      if (fence && request.generation < fence.generation)
        throw new Error("Allocation claim superseded");
      if (old?.owner && old.owner !== owner) throw new Error("Allocation name already owned");
      let epoch: number;
      if (request.epoch !== undefined) {
        if (old?.owner !== owner || old.epoch !== request.epoch)
          throw new Error("Allocation name superseded");
        epoch = old.epoch;
      } else if (fence?.generation === request.generation) {
        if (old?.owner !== owner || old.epoch !== fence.epoch)
          throw new Error("Allocation claim retired");
        return fence.epoch;
      } else epoch = (old?.epoch ?? 0) + 1;
      sql.exec(
        "INSERT INTO allocation_generations VALUES (?, ?, ?) ON CONFLICT(owner) DO UPDATE SET generation = excluded.generation, epoch = excluded.epoch",
        owner,
        request.generation,
        epoch,
      );
      sql.exec(
        "INSERT INTO allocation_route VALUES (1, ?, ?) ON CONFLICT(singleton) DO UPDATE SET epoch = excluded.epoch, owner = excluded.owner",
        epoch,
        owner,
      );
      return epoch;
    });
  }
  async release(request: { version: number; owner: AllocationOwner; epoch: number }) {
    checkRpc(request.version);
    if (!this.initialized()) return false;
    return (
      this.ctx.storage.sql
        .exec(
          "UPDATE allocation_route SET owner = NULL WHERE epoch = ? AND owner = ? RETURNING epoch",
          request.epoch,
          canonicalJson(request.owner),
        )
        .toArray().length > 0
    );
  }
  async inventory(request: { version: number }) {
    checkRpc(request.version);
    const initialized = this.initialized();
    return {
      version: request.version,
      schemaVersion: initialized ? allocationRouteMigrations.length : 0,
      tables: [
        summarize(
          "allocation_generations",
          initialized
            ? this.ctx.storage.sql.exec(
                "SELECT owner, generation, epoch FROM allocation_generations ORDER BY owner",
              )
            : [],
        ),
        summarize(
          "allocation_route",
          initialized ? this.ctx.storage.sql.exec("SELECT epoch, owner FROM allocation_route") : [],
        ),
      ],
    };
  }
}
