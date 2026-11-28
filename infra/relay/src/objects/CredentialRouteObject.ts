import { DurableObject } from "cloudflare:workers";
import { checkRpc, migrate, summarize } from "./storage.ts";

export const credentialRouteMigrations = [
  "CREATE TABLE credential_route (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), destination TEXT NOT NULL)",
];
export class CredentialRouteObject extends DurableObject<unknown> {
  async publish(request: { version: number; destination: string }) {
    checkRpc(request.version);
    migrate(this.ctx.storage, credentialRouteMigrations);
    this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      sql.exec("INSERT OR IGNORE INTO credential_route VALUES (1, ?)", request.destination);
      if (
        sql.exec<{ destination: string }>("SELECT destination FROM credential_route").one()
          .destination !== request.destination
      )
        throw new Error("Credential route is immutable");
    });
  }
  async resolve(request: { version: number }) {
    checkRpc(request.version);
    if (
      !this.ctx.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE name = 'credential_route'")
        .toArray().length
    )
      return null;
    migrate(this.ctx.storage, credentialRouteMigrations);
    return (
      this.ctx.storage.sql
        .exec<{ destination: string }>("SELECT destination FROM credential_route")
        .toArray()[0]?.destination ?? null
    );
  }
  async inventory(request: { version: number }) {
    checkRpc(request.version);
    const initialized =
      this.ctx.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE name = 'credential_route'")
        .toArray().length > 0;
    if (initialized) migrate(this.ctx.storage, credentialRouteMigrations);
    return {
      version: request.version,
      schemaVersion: initialized ? credentialRouteMigrations.length : 0,
      tables: [
        summarize(
          "credential_route",
          initialized ? this.ctx.storage.sql.exec("SELECT destination FROM credential_route") : [],
        ),
      ],
    };
  }
}
