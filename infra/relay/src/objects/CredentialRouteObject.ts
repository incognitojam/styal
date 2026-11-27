import { DurableObject } from "cloudflare:workers";
import { checkRpc, migrate, summarize } from "./storage.ts";

export const credentialRouteMigrations = [
  "CREATE TABLE credential_route (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), destination TEXT NOT NULL)",
];
export class CredentialRouteObject extends DurableObject<unknown> {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      migrate(ctx.storage, credentialRouteMigrations);
    });
  }
  async publish(request: { version: number; destination: string }) {
    checkRpc(request.version);
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
    return (
      this.ctx.storage.sql
        .exec<{ destination: string }>("SELECT destination FROM credential_route")
        .toArray()[0]?.destination ?? null
    );
  }
  async inventory(request: { version: number }) {
    checkRpc(request.version);
    return {
      version: request.version,
      schemaVersion: credentialRouteMigrations.length,
      tables: [
        summarize(
          "credential_route",
          this.ctx.storage.sql.exec("SELECT destination FROM credential_route"),
        ),
      ],
    };
  }
}
