import { DurableObject } from "cloudflare:workers";
import { pushTokenName } from "./names.ts";
import { canonicalJson, checkRpc, migrate, summarize } from "./storage.ts";

export type TokenKind = "push" | "push-to-start" | "live-activity";
export interface TokenReference {
  kind: TokenKind;
  token: string;
  userId: string;
  deviceId: string;
  sessionId: string | null;
  operationId: string;
  generation: number;
}
const migrations = [
  `CREATE TABLE token_owner (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), generation INTEGER NOT NULL, owner TEXT);
   CREATE TABLE token_claims (operation_id TEXT PRIMARY KEY, request TEXT NOT NULL, applied INTEGER NOT NULL, lost_at TEXT)`,
];

export class PushTokenObject extends DurableObject<unknown> {
  private initialized() {
    return (
      this.ctx.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE name = 'token_owner'")
        .toArray().length > 0
    );
  }
  private owner() {
    if (!this.initialized()) return { generation: 0, owner: null as TokenReference | null };
    const row = this.ctx.storage.sql
      .exec<{ generation: number; owner: string | null }>(
        "SELECT generation, owner FROM token_owner",
      )
      .toArray()[0];
    return {
      generation: row?.generation ?? 0,
      owner: row?.owner ? (JSON.parse(row.owner) as TokenReference) : null,
    };
  }
  async read(request: { version: number }) {
    checkRpc(request.version);
    return { ...this.owner(), initialized: this.initialized() };
  }
  async status(request: { version: number; reference: TokenReference }) {
    checkRpc(request.version);
    this.check(request.reference);
    const current = this.owner();
    const lost = this.initialized()
      ? this.ctx.storage.sql
          .exec<{ lost_at: string | null }>(
            "SELECT lost_at FROM token_claims WHERE operation_id = ?",
            request.reference.operationId,
          )
          .toArray()[0]
      : null;
    return {
      live: canonicalJson(current.owner) === canonicalJson(request.reference),
      lostAt: lost?.lost_at ?? null,
    };
  }
  private check(reference: TokenReference) {
    if (this.ctx.id.name !== pushTokenName(reference.kind, reference.token))
      throw new Error("Push token identity mismatch");
  }
  async transfer(request: {
    version: number;
    reference: TokenReference;
    expected: number;
    now: string;
    registered?: true;
  }) {
    checkRpc(request.version);
    this.check(request.reference);
    if (request.reference.generation !== request.expected + 1)
      throw new Error("Push token generation mismatch");
    if (!this.initialized() && !request.registered) return { needsRegistration: true } as const;
    return this.ctx.storage.transactionSync(() => {
      migrate(this.ctx.storage, migrations);
      const intent = canonicalJson({ reference: request.reference, expected: request.expected });
      const receipt = this.ctx.storage.sql
        .exec<{ request: string; applied: number }>(
          "SELECT request, applied FROM token_claims WHERE operation_id = ?",
          request.reference.operationId,
        )
        .toArray()[0];
      if (receipt) {
        if (receipt.request !== intent) throw new Error("Push token intent mismatch");
        return { applied: !!receipt.applied };
      }
      const current = this.owner();
      const applied = current.generation === request.expected;
      this.ctx.storage.sql.exec(
        "INSERT INTO token_claims VALUES (?, ?, ?, NULL)",
        request.reference.operationId,
        intent,
        Number(applied),
      );
      if (applied) {
        if (current.owner)
          this.ctx.storage.sql.exec(
            "UPDATE token_claims SET lost_at = coalesce(lost_at, ?) WHERE operation_id = ?",
            request.now,
            current.owner.operationId,
          );
        this.ctx.storage.sql.exec(
          "INSERT INTO token_owner VALUES (1, ?, ?) ON CONFLICT(singleton) DO UPDATE SET generation = excluded.generation, owner = excluded.owner",
          request.reference.generation,
          canonicalJson(request.reference),
        );
      }
      return { applied };
    });
  }
  async clear(request: { version: number; reference: TokenReference; now: string }) {
    checkRpc(request.version);
    this.check(request.reference);
    if (canonicalJson(this.owner().owner) !== canonicalJson(request.reference)) return false;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "UPDATE token_claims SET lost_at = coalesce(lost_at, ?) WHERE operation_id = ?",
        request.now,
        request.reference.operationId,
      );
      this.ctx.storage.sql.exec("UPDATE token_owner SET generation = generation + 1, owner = NULL");
    });
    return true;
  }
  async fence(request: {
    version: number;
    reference: TokenReference;
    expected: number;
    now: string;
    registered?: true;
  }) {
    checkRpc(request.version);
    this.check(request.reference);
    if (!this.initialized() && !request.registered) return { needsRegistration: true } as const;
    this.ctx.storage.transactionSync(() => {
      migrate(this.ctx.storage, migrations);
      const intent = canonicalJson({ reference: request.reference, expected: request.expected });
      const old = this.ctx.storage.sql
        .exec<{ request: string }>(
          "SELECT request FROM token_claims WHERE operation_id = ?",
          request.reference.operationId,
        )
        .toArray()[0];
      if (old && old.request !== intent) throw new Error("Push token intent mismatch");
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO token_claims VALUES (?, ?, 0, NULL)",
        request.reference.operationId,
        intent,
      );
      if (canonicalJson(this.owner().owner) === canonicalJson(request.reference)) {
        this.ctx.storage.sql.exec(
          "UPDATE token_claims SET lost_at = coalesce(lost_at, ?) WHERE operation_id = ?",
          request.now,
          request.reference.operationId,
        );
        this.ctx.storage.sql.exec(
          "UPDATE token_owner SET generation = generation + 1, owner = NULL",
        );
      }
    });
    return { fenced: true } as const;
  }
  async inventory(request: { version: number }) {
    checkRpc(request.version);
    return {
      version: request.version,
      schemaVersion: this.initialized() ? migrations.length : 0,
      tables: [
        summarize(
          "token_owner",
          this.initialized() ? this.ctx.storage.sql.exec("SELECT * FROM token_owner") : [],
        ),
        summarize(
          "token_claims",
          this.initialized()
            ? this.ctx.storage.sql.exec("SELECT * FROM token_claims ORDER BY operation_id")
            : [],
        ),
      ],
    };
  }
}
