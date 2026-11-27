import { DurableObject } from "cloudflare:workers";
import { replayName } from "./names.ts";
import { checkRpc, migrate, summarize } from "./storage.ts";

const migrations = [
  `CREATE TABLE replay_proofs (
    thumbprint TEXT NOT NULL CHECK(length(thumbprint) <= 128),
    jti TEXT NOT NULL CHECK(length(jti) <= 255),
    iat INTEGER NOT NULL CHECK(typeof(iat) = 'integer' AND iat BETWEEN -2147483648 AND 2147483647),
    expires_at TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY(thumbprint, jti)
  ); CREATE INDEX replay_expiry ON replay_proofs(expires_at)`,
];

export class ReplayObject extends DurableObject<unknown> {
  private initialized() {
    return (
      this.ctx.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE name = 'replay_proofs'")
        .toArray().length > 0
    );
  }

  async consume(request: {
    version: number;
    thumbprint: string;
    jti: string;
    iat: number;
    expiresAt: string;
    createdAt: string;
    registered?: true;
  }): Promise<{ needsRegistration: true } | { consumed: boolean }> {
    checkRpc(request.version);
    if (this.ctx.id.name !== replayName(request.thumbprint, request.jti))
      throw new Error("Replay identity mismatch");
    if (!this.initialized() && !request.registered) return { needsRegistration: true };
    return this.ctx.storage.transactionSync(() => {
      migrate(this.ctx.storage, migrations);
      const rows = this.ctx.storage.sql
        .exec(
          "INSERT INTO replay_proofs VALUES (?, ?, ?, ?, ?) ON CONFLICT(thumbprint, jti) DO NOTHING RETURNING jti",
          request.thumbprint,
          request.jti,
          request.iat,
          request.expiresAt,
          request.createdAt,
        )
        .toArray();
      return { consumed: rows.length > 0 };
    });
  }

  async prune(request: { version: number; expiresBefore: string }) {
    checkRpc(request.version);
    if (!this.initialized()) return;
    migrate(this.ctx.storage, migrations);
    this.ctx.storage.sql.exec(
      "DELETE FROM replay_proofs WHERE expires_at < ?",
      request.expiresBefore,
    );
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
          "relay_dpop_proofs",
          initialized
            ? this.ctx.storage.sql.exec(
                "SELECT thumbprint, jti, iat, expires_at AS expiresAt, created_at AS createdAt FROM replay_proofs ORDER BY thumbprint, jti",
              )
            : [],
        ),
      ],
    };
  }
}
