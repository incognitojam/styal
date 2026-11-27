import { DurableObject } from "cloudflare:workers";
import {
  SIGN_IN_CODE_MAX_ATTEMPTS,
  SIGN_IN_CODES_PER_KEY_PER_HOUR,
  SIGN_IN_CODES_PER_EMAIL_PER_HOUR,
} from "../auth/EmailSignInCodes.ts";
import type { RedeemResult } from "../auth/EmailSignInCodes.ts";
import { canonicalJson, checkRpc, migrate, summarize } from "./storage.ts";

export interface EmailOwner {
  userId: string;
  accountEpoch: number;
  emailEpoch: number;
  operationId: string;
}
export interface CodeRow {
  codeId: string;
  email: string;
  thumbprint: string;
  codeHash: string;
  attempts: number;
  consumedAt: string | null;
  createdAt: string;
  expiresAt: string;
}
export const emailMigrations = [
  `CREATE TABLE email_owner (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), epoch INTEGER NOT NULL, owner TEXT);
   INSERT INTO email_owner VALUES (1, 0, NULL);
   CREATE TABLE email_claims (operation_id TEXT PRIMARY KEY, intent TEXT NOT NULL, result TEXT NOT NULL);
   CREATE TABLE code_issuance (code_id TEXT PRIMARY KEY, intent TEXT NOT NULL);
   CREATE TABLE sign_in_codes (code_id TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE INDEX codes_key ON sign_in_codes(json_extract(value, '$.thumbprint'), json_extract(value, '$.createdAt'));`,
  "ALTER TABLE email_owner ADD COLUMN issuance_cutoff TEXT NOT NULL DEFAULT ''",
];
export class EmailObject extends DurableObject<unknown> {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      migrate(ctx.storage, emailMigrations);
    });
  }
  async resolve(request: { version: number }): Promise<EmailOwner | null> {
    checkRpc(request.version);
    const row = this.ctx.storage.sql
      .exec<{ owner: string | null }>("SELECT owner FROM email_owner")
      .one();
    return row.owner ? JSON.parse(row.owner) : null;
  }
  async claim(request: {
    version: number;
    userId: string;
    accountEpoch: number;
    operationId: string;
    signup: boolean;
  }): Promise<EmailOwner | null> {
    checkRpc(request.version);
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const intent = canonicalJson(request);
      const previous = sql
        .exec<{ intent: string; result: string }>(
          "SELECT intent, result FROM email_claims WHERE operation_id = ?",
          request.operationId,
        )
        .toArray()[0];
      if (previous) {
        if (previous.intent !== intent) throw new Error("Email claim intent mismatch");
        return JSON.parse(previous.result) as EmailOwner | null;
      }
      const row = sql
        .exec<{ epoch: number; owner: string | null }>("SELECT epoch, owner FROM email_owner")
        .one();
      const old: EmailOwner | null = row.owner ? JSON.parse(row.owner) : null;
      const result =
        old && request.signup
          ? old
          : old && (old.userId !== request.userId || old.accountEpoch >= request.accountEpoch)
            ? null
            : {
                userId: request.userId,
                accountEpoch: request.accountEpoch,
                operationId: request.operationId,
                emailEpoch: row.epoch + 1,
              };
      if (result && result !== old)
        sql.exec(
          "UPDATE email_owner SET epoch = ?, owner = ?",
          result.emailEpoch,
          canonicalJson(result),
        );
      sql.exec(
        "INSERT INTO email_claims VALUES (?, ?, ?)",
        request.operationId,
        intent,
        canonicalJson(result),
      );
      return result;
    });
  }
  async release(request: { version: number; owner: EmailOwner; now: string }) {
    checkRpc(request.version);
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const row = sql.exec<{ owner: string | null }>("SELECT owner FROM email_owner").one();
      if (row.owner !== canonicalJson(request.owner)) return false;
      sql.exec("UPDATE email_owner SET owner = NULL");
      sql.exec(
        "UPDATE sign_in_codes SET value = json_set(value, '$.consumedAt', ?) WHERE json_extract(value, '$.consumedAt') IS NULL",
        request.now,
      );
      return true;
    });
  }
  async issue(request: {
    version: number;
    code: CodeRow;
    windowStart: string;
  }): Promise<number | null> {
    checkRpc(request.version);
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const { issuance_cutoff } = sql
        .exec<{ issuance_cutoff: string }>("SELECT issuance_cutoff FROM email_owner")
        .one();
      // The cutoff fences delayed issuance RPCs after their deduplication rows are pruned.
      if (request.code.expiresAt <= issuance_cutoff) return null;
      const intent = canonicalJson(request.code);
      const old = sql
        .exec<{ intent: string }>(
          "SELECT intent FROM code_issuance WHERE code_id = ?",
          request.code.codeId,
        )
        .toArray()[0];
      if (old) {
        if (old.intent !== intent) throw new Error("Code intent mismatch");
        return null;
      }
      const recent = sql
        .exec<{ value: string }>(
          "SELECT value FROM sign_in_codes WHERE json_extract(value, '$.createdAt') >= ? ORDER BY json_extract(value, '$.createdAt')",
          request.windowStart,
        )
        .toArray()
        .map((row) => JSON.parse(row.value) as CodeRow);
      const key = recent.filter((row) => row.thumbprint === request.code.thumbprint);
      const limited =
        key.length >= SIGN_IN_CODES_PER_KEY_PER_HOUR
          ? key
          : recent.length >= SIGN_IN_CODES_PER_EMAIL_PER_HOUR
            ? recent
            : [];
      if (limited[0])
        return Math.max(
          1,
          Math.ceil(
            (Date.parse(limited[0].createdAt) + 3600000 - Date.parse(request.code.createdAt)) /
              1000,
          ),
        );
      sql.exec("INSERT INTO code_issuance VALUES (?, ?)", request.code.codeId, intent);
      sql.exec(
        "INSERT INTO sign_in_codes VALUES (?, ?)",
        request.code.codeId,
        canonicalJson(request.code),
      );
      return null;
    });
  }
  async latest(request: { version: number; thumbprint: string }): Promise<CodeRow | null> {
    checkRpc(request.version);
    const row = this.ctx.storage.sql
      .exec<{ value: string }>(
        "SELECT value FROM sign_in_codes WHERE json_extract(value, '$.thumbprint') = ? ORDER BY json_extract(value, '$.createdAt') DESC, rowid DESC LIMIT 1",
        request.thumbprint,
      )
      .toArray()[0];
    return row ? JSON.parse(row.value) : null;
  }
  async redeem(request: {
    version: number;
    thumbprint: string;
    codeId: string;
    codeHash: string;
    now: string;
  }): Promise<RedeemResult> {
    checkRpc(request.version);
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const row = sql
        .exec<{ value: string }>(
          "SELECT value FROM sign_in_codes WHERE json_extract(value, '$.thumbprint') = ? ORDER BY json_extract(value, '$.createdAt') DESC, rowid DESC LIMIT 1",
          request.thumbprint,
        )
        .toArray()[0];
      const code: CodeRow | null = row ? JSON.parse(row.value) : null;
      if (
        !code ||
        code.codeId !== request.codeId ||
        code.consumedAt !== null ||
        code.expiresAt <= request.now
      )
        return "expired";
      if (code.attempts >= SIGN_IN_CODE_MAX_ATTEMPTS) return "too_many_attempts";
      code.attempts++;
      const equal = constantTimeEqual(code.codeHash, request.codeHash);
      if (equal) code.consumedAt = request.now;
      sql.exec(
        "UPDATE sign_in_codes SET value = ? WHERE code_id = ?",
        canonicalJson(code),
        code.codeId,
      );
      return equal
        ? "redeemed"
        : code.attempts >= SIGN_IN_CODE_MAX_ATTEMPTS
          ? "too_many_attempts"
          : "incorrect";
    });
  }
  async discard(request: { version: number; codeId: string }) {
    checkRpc(request.version);
    this.ctx.storage.sql.exec("DELETE FROM sign_in_codes WHERE code_id = ?", request.codeId);
  }
  async prune(request: { version: number; cutoff: string }) {
    checkRpc(request.version);
    this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      sql.exec("UPDATE email_owner SET issuance_cutoff = MAX(issuance_cutoff, ?)", request.cutoff);
      sql.exec(
        "DELETE FROM code_issuance WHERE json_extract(intent, '$.expiresAt') <= (SELECT issuance_cutoff FROM email_owner)",
      );
      sql.exec(
        "DELETE FROM sign_in_codes WHERE json_extract(value, '$.expiresAt') <= (SELECT issuance_cutoff FROM email_owner)",
      );
    });
  }
  async inventory(request: { version: number }) {
    checkRpc(request.version);
    return {
      version: request.version,
      schemaVersion: emailMigrations.length,
      tables: [
        summarize("email_owner", this.ctx.storage.sql.exec("SELECT * FROM email_owner")),
        summarize(
          "code_issuance",
          this.ctx.storage.sql.exec("SELECT * FROM code_issuance ORDER BY code_id"),
        ),
        summarize(
          "email_claims",
          this.ctx.storage.sql.exec("SELECT * FROM email_claims ORDER BY operation_id"),
        ),
        summarize(
          "relay_email_sign_in_codes",
          this.ctx.storage.sql
            .exec<{ value: string }>("SELECT value FROM sign_in_codes ORDER BY code_id")
            .toArray()
            .map((row) => JSON.parse(row.value)),
        ),
      ],
    };
  }
}
function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return difference === 0;
}
