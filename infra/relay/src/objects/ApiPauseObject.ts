import { DurableObject } from "cloudflare:workers";
import { apiPauseName } from "./names.ts";
import { checkRpc, migrate, summarize } from "./storage.ts";

const migrations = [
  "CREATE TABLE api_pause (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), api TEXT NOT NULL, paused_until_ms INTEGER NOT NULL CHECK(typeof(paused_until_ms) = 'integer'))",
];

export class ApiPauseObject extends DurableObject<unknown> {
  private initialized() {
    return (
      this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name = 'api_pause'").toArray()
        .length > 0
    );
  }

  async read(request: { version: number; api: string }) {
    checkRpc(request.version);
    if (this.ctx.id.name !== apiPauseName(request.api))
      throw new Error("API pause identity mismatch");
    if (!this.initialized()) return 0;
    migrate(this.ctx.storage, migrations);
    return (
      this.ctx.storage.sql
        .exec<{ paused_until_ms: number }>("SELECT paused_until_ms FROM api_pause")
        .toArray()[0]?.paused_until_ms ?? 0
    );
  }

  async extend(request: {
    version: number;
    api: string;
    untilMillis: number;
    registered?: true;
  }): Promise<{ needsRegistration: true } | { extended: true }> {
    checkRpc(request.version);
    if (this.ctx.id.name !== apiPauseName(request.api))
      throw new Error("API pause identity mismatch");
    if (!Number.isInteger(request.untilMillis))
      throw new Error("API pause deadline must be an integer");
    if (!this.initialized() && !request.registered) return { needsRegistration: true };
    this.ctx.storage.transactionSync(() => {
      migrate(this.ctx.storage, migrations);
      this.ctx.storage.sql.exec(
        "INSERT INTO api_pause VALUES (1, ?, ?) ON CONFLICT(singleton) DO UPDATE SET paused_until_ms = max(api_pause.paused_until_ms, excluded.paused_until_ms)",
        request.api,
        request.untilMillis,
      );
    });
    return { extended: true };
  }

  async inventory(request: { version: number }) {
    checkRpc(request.version);
    const initialized = this.initialized();
    if (initialized) migrate(this.ctx.storage, migrations);
    return {
      version: request.version,
      schemaVersion: initialized ? migrations.length : 0,
      tables: [
        summarize(
          "relay_upstream_api_pauses",
          initialized
            ? this.ctx.storage.sql.exec(
                "SELECT api, paused_until_ms AS pausedUntilMs FROM api_pause",
              )
            : [],
        ),
      ],
    };
  }
}
