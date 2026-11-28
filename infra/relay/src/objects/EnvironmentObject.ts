import { DurableObject } from "cloudflare:workers";
import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import { RelayAgentActivityState as ActivitySchema } from "@t3tools/contracts/relay";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { canonicalJson, checkRpc, migrate, summarize } from "./storage.ts";
import { environmentName } from "./names.ts";

const parseActivity = Schema.decodeUnknownSync(ActivitySchema);
const decodeActivity = Schema.decodeUnknownOption(ActivitySchema);

export const MACHINE_AUTH_OWNER_LIMIT = 32;

export interface EnvironmentCandidate {
  userId: string;
  environmentPublicKey: string;
  generation: number;
  published: boolean;
  revoked: boolean;
  holdWebhooksWhileOffline: boolean;
}
export interface MachineCredential {
  credentialId: string;
  tokenHash: string;
  environmentPublicKey: string;
  createdAt: string;
  link?: { userId: string; generation: number };
}
export const environmentMigrations = [
  `CREATE TABLE environment_identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), environment_id TEXT NOT NULL);
   CREATE TABLE candidates (user_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, value TEXT NOT NULL);
   CREATE INDEX candidate_key ON candidates(json_extract(value, '$.environmentPublicKey'), json_extract(value, '$.revoked'), json_extract(value, '$.published'), user_id);
   CREATE TABLE credentials (hash TEXT PRIMARY KEY, credential_id TEXT NOT NULL UNIQUE, public_key TEXT NOT NULL, created_at TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE activity (public_key TEXT NOT NULL, thread_id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(public_key, thread_id));`,
  // Older unpublished intents lack the generation needed for safe publication.
  `ALTER TABLE credentials ADD COLUMN link_user_id TEXT;
   ALTER TABLE credentials ADD COLUMN link_generation INTEGER;
   UPDATE credentials SET revoked = 1 WHERE published = 0;`,
];
export class EnvironmentObject extends DurableObject<unknown> {
  private initialized() {
    const initialized =
      this.ctx.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE name = 'candidates'")
        .toArray().length > 0;
    if (initialized) migrate(this.ctx.storage, environmentMigrations);
    return initialized;
  }

  private check(request: { version: number; environmentId: string }) {
    checkRpc(request.version);
    if (this.ctx.id.name !== environmentName(request.environmentId))
      throw new Error("Environment mismatch");
  }
  async candidates(request: { version: number; environmentId: string }) {
    this.check(request);
    return this.readCandidates();
  }
  private readCandidates() {
    if (!this.initialized()) return [];
    return this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM candidates ORDER BY user_id")
      .toArray()
      .map((r) => JSON.parse(r.value) as EnvironmentCandidate)
      .filter((r) => !r.revoked);
  }
  private own(environmentId: string) {
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO environment_identity VALUES (1, ?)",
      environmentId,
    );
  }
  async owner(request: { version: number }) {
    checkRpc(request.version);
    if (!this.initialized()) return null;
    return (
      this.ctx.storage.sql
        .exec<{ environment_id: string }>("SELECT environment_id FROM environment_identity")
        .toArray()[0]?.environment_id ?? null
    );
  }
  async candidate(request: {
    version: number;
    environmentId: string;
    candidate: EnvironmentCandidate;
  }) {
    this.check(request);
    migrate(this.ctx.storage, environmentMigrations);
    return this.ctx.storage.transactionSync(() => {
      this.own(request.environmentId);
      const sql = this.ctx.storage.sql;
      const c = request.candidate;
      const row = sql
        .exec<{ value: string }>("SELECT value FROM candidates WHERE user_id = ?", c.userId)
        .toArray()[0];
      const old: EnvironmentCandidate | null = row ? JSON.parse(row.value) : null;
      if (old && old.generation > c.generation) return false;
      if (old?.generation === c.generation) {
        if (old.environmentPublicKey !== c.environmentPublicKey)
          throw new Error("Candidate intent mismatch");
        if (old.revoked) return c.revoked;
        if (old.published && !c.revoked) return true;
      }
      sql.exec(
        "INSERT INTO candidates VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET generation = excluded.generation, value = excluded.value",
        c.userId,
        c.generation,
        canonicalJson(c),
      );
      return true;
    });
  }
  async setHold(request: {
    version: number;
    environmentId: string;
    environmentPublicKey: string;
    hold: boolean;
    members: { userId: string; generation: number }[];
  }) {
    this.check(request);
    if (!this.initialized()) return;
    this.ctx.storage.transactionSync(() => {
      for (const m of request.members)
        this.ctx.storage.sql.exec(
          "UPDATE candidates SET value = json_set(value, '$.holdWebhooksWhileOffline', json(?)) WHERE user_id = ? AND generation = ? AND json_extract(value, '$.environmentPublicKey') = ? AND json_extract(value, '$.revoked') = 0 AND json_extract(value, '$.published') = 1",
          request.hold ? "true" : "false",
          m.userId,
          m.generation,
          request.environmentPublicKey,
        );
    });
  }
  async installCredential(request: {
    version: number;
    environmentId: string;
    credential: MachineCredential;
  }) {
    this.check(request);
    migrate(this.ctx.storage, environmentMigrations);
    this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      this.own(request.environmentId);
      const c = request.credential;
      if (c.link) {
        const row = sql
          .exec<{ value: string }>(
            "SELECT value FROM candidates WHERE user_id = ? AND generation = ?",
            c.link.userId,
            c.link.generation,
          )
          .toArray()[0];
        const owner: EnvironmentCandidate | null = row ? JSON.parse(row.value) : null;
        if (!owner || owner.revoked || owner.environmentPublicKey !== c.environmentPublicKey)
          throw new Error("Credential link superseded");
      }
      const old = sql
        .exec<{ credential_id: string; public_key: string }>(
          "SELECT credential_id, public_key FROM credentials WHERE hash = ?",
          c.tokenHash,
        )
        .toArray()[0];
      if (old) {
        if (old.credential_id !== c.credentialId || old.public_key !== c.environmentPublicKey)
          throw new Error("Credential intent mismatch");
        return;
      }
      sql.exec(
        "INSERT INTO credentials(hash, credential_id, public_key, created_at, link_user_id, link_generation) VALUES (?, ?, ?, ?, ?, ?)",
        c.tokenHash,
        c.credentialId,
        c.environmentPublicKey,
        c.createdAt,
        c.link?.userId ?? null,
        c.link?.generation ?? null,
      );
    });
  }
  async publishCredential(request: { version: number; environmentId: string; tokenHash: string }) {
    this.check(request);
    if (!this.initialized()) return false;
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const row = sql
        .exec<{
          public_key: string;
          published: number;
          revoked: number;
          link_user_id: string | null;
          link_generation: number | null;
        }>(
          "SELECT public_key, published, revoked, link_user_id, link_generation FROM credentials WHERE hash = ?",
          request.tokenHash,
        )
        .toArray()[0];
      if (!row) return false;
      if (row.published) return true;
      if (row.revoked) return false;
      if (row.link_user_id !== null) {
        const candidate = sql
          .exec<{ value: string }>(
            "SELECT value FROM candidates WHERE user_id = ? AND generation = ?",
            row.link_user_id,
            row.link_generation!,
          )
          .toArray()[0];
        const owner: EnvironmentCandidate | null = candidate ? JSON.parse(candidate.value) : null;
        if (!owner || owner.revoked || owner.environmentPublicKey !== row.public_key)
          throw new Error("Credential link superseded");
      }
      sql.exec(
        "UPDATE credentials SET revoked = 1 WHERE public_key = ? AND hash <> ? AND published = 1",
        row.public_key,
        request.tokenHash,
      );
      sql.exec("UPDATE credentials SET published = 1 WHERE hash = ?", request.tokenHash);
      return true;
    });
  }

  async credential(request: { version: number; environmentId: string; tokenHash: string }) {
    this.check(request);
    if (!this.initialized()) return null;
    const credential = this.ctx.storage.sql
      .exec<{ credential_id: string; public_key: string }>(
        "SELECT credential_id, public_key FROM credentials WHERE hash = ? AND published = 1 AND revoked = 0",
        request.tokenHash,
      )
      .toArray()[0];
    if (!credential) return null;
    const candidates = this.ctx.storage.sql
      .exec<{ value: string }>(
        "SELECT value FROM candidates WHERE json_extract(value, '$.environmentPublicKey') = ? AND json_extract(value, '$.revoked') = 0 AND json_extract(value, '$.published') = 1 ORDER BY user_id LIMIT ?",
        credential.public_key,
        MACHINE_AUTH_OWNER_LIMIT,
      )
      .toArray()
      .map((row) => JSON.parse(row.value) as EnvironmentCandidate);
    return {
      credentialId: credential.credential_id,
      environmentPublicKey: credential.public_key,
      candidates,
    };
  }

  async revokeCredentials(request: {
    version: number;
    environmentId: string;
    environmentPublicKey: string;
  }) {
    this.check(request);
    if (!this.initialized()) return false;
    // Pending candidates postpone cleanup; an unavailable owner is never presumed dead.
    return this.ctx.storage.transactionSync(() => {
      const candidate = this.ctx.storage.sql
        .exec(
          "SELECT user_id FROM candidates WHERE json_extract(value, '$.environmentPublicKey') = ? AND json_extract(value, '$.revoked') = 0 LIMIT 1",
          request.environmentPublicKey,
        )
        .toArray()[0];
      if (candidate) return false;
      return (
        this.ctx.storage.sql
          .exec(
            "UPDATE credentials SET revoked = 1 WHERE public_key = ? AND revoked = 0 RETURNING hash",
            request.environmentPublicKey,
          )
          .toArray().length > 0
      );
    });
  }
  async activity(request: {
    version: number;
    environmentId: string;
    registered?: boolean;
    command:
      | { kind: "upsert"; environmentPublicKey: string; state: RelayAgentActivityState }
      | { kind: "remove"; environmentPublicKey: string; threadId: string }
      | { kind: "read"; environmentPublicKey: string }
      | { kind: "prune"; updatedBefore: string };
  }) {
    this.check(request);
    if (request.command.kind === "upsert" && !this.initialized()) {
      if (!request.registered) return { needsRegistration: true, previous: null, states: [] };
      migrate(this.ctx.storage, environmentMigrations);
    }
    if (!this.initialized()) return { needsRegistration: false, previous: null, states: [] };
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const c = request.command;
      if (c.kind === "upsert") {
        this.own(request.environmentId);
        const state = parseActivity(c.state);
        if (state.environmentId !== request.environmentId)
          throw new Error("Activity environment mismatch");
        const previous = sql
          .exec<{ value: string }>(
            "SELECT value FROM activity WHERE public_key = ? AND thread_id = ?",
            c.environmentPublicKey,
            state.threadId,
          )
          .toArray()[0];
        sql.exec(
          "INSERT INTO activity VALUES (?, ?, ?) ON CONFLICT(public_key, thread_id) DO UPDATE SET value = excluded.value",
          c.environmentPublicKey,
          state.threadId,
          canonicalJson(state),
        );
        return {
          needsRegistration: false,
          previous: previous ? Option.getOrNull(decodeActivity(JSON.parse(previous.value))) : null,
          states: [],
        };
      }
      if (c.kind === "remove")
        sql.exec(
          "DELETE FROM activity WHERE public_key = ? AND thread_id = ?",
          c.environmentPublicKey,
          c.threadId,
        );
      if (c.kind === "prune")
        sql.exec(
          "DELETE FROM activity WHERE json_extract(value, '$.phase') IN ('completed','failed') AND json_extract(value, '$.updatedAt') < ?",
          c.updatedBefore,
        );
      return {
        needsRegistration: false,
        previous: null,
        states:
          c.kind === "read"
            ? sql
                .exec<{ value: string }>(
                  "SELECT value FROM activity WHERE public_key = ? ORDER BY json_extract(value, '$.updatedAt') DESC",
                  c.environmentPublicKey,
                )
                .toArray()
                .flatMap((r) => Option.toArray(decodeActivity(JSON.parse(r.value))))
            : [],
      };
    });
  }
  async inventory(request: { version: number }) {
    checkRpc(request.version);
    return {
      version: request.version,
      schemaVersion: this.initialized() ? environmentMigrations.length : 0,
      tables: ["environment_identity", "candidates", "credentials", "activity"].map((table) =>
        summarize(
          table,
          this.initialized()
            ? this.ctx.storage.sql.exec(`SELECT * FROM ${table} ORDER BY 1, 2`)
            : [],
        ),
      ),
    };
  }
}
