import type { AuthSession } from "../auth/AuthSessions.ts";
import { canonicalJson, checkRpc, summarize } from "./storage.ts";

export const identityMigration = `CREATE TABLE account_identity (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), value TEXT NOT NULL);
CREATE TABLE email_operations (operation_id TEXT PRIMARY KEY, requested TEXT);
CREATE TABLE account_sessions (session_id TEXT PRIMARY KEY, value TEXT NOT NULL);`;
export interface EmailMapping {
  email: string;
  emailEpoch: number;
  accountEpoch: number;
  operationId: string;
}
export interface EmailChange {
  operationId: string;
  requested: string | null;
  old: EmailMapping | null;
  epoch: number;
  phase: "claim" | "release";
}
export interface IdentityState {
  userId: string;
  email: string | null;
  epoch: number;
  mapping: EmailMapping | null;
  pending: EmailChange | null;
  createdAt: string;
  updatedAt: string;
  lastSignInAt: string | null;
}
export interface StoredSession extends AuthSession {
  tokenHash: string;
  thumbprint: string;
  expiresAt: string;
  published: boolean;
  revoked: boolean;
}
interface SessionRecord extends StoredSession {
  accountEpoch: number;
}
export type IdentityCommand =
  | { kind: "read" }
  | { kind: "create"; state: IdentityState }
  | { kind: "touch"; now: string; epoch: number }
  | { kind: "begin-email"; userId: string; operationId: string; email: string | null; now: string }
  | { kind: "commit-email"; operationId: string; mapping: EmailMapping | null; now: string }
  | { kind: "finish-email"; operationId: string }
  | { kind: "open-session"; session: StoredSession }
  | { kind: "publish-session"; sessionId: string }
  | { kind: "session"; sessionId: string }
  | {
      kind: "use-session";
      sessionId: string;
      tokenHash: string;
      thumbprint: string;
      now: string;
      cutoff: string;
      expiresAt: string;
      revoke: boolean;
    }
  | { kind: "revoke-session"; sessionId: string }
  | { kind: "list-sessions"; now: string }
  | { kind: "prune-sessions"; now: string };

export function identity(
  storage: DurableObjectStorage,
  request: { version: number; command: IdentityCommand },
) {
  checkRpc(request.version);
  return storage.transactionSync(() => {
    const sql = storage.sql;
    const state = read<IdentityState>(storage, "account_identity", "singleton = 1");
    const save = (next: IdentityState) => {
      sql.exec(
        "INSERT INTO account_identity VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET value = excluded.value",
        canonicalJson(next),
      );
      return next;
    };
    const saveSession = (session: SessionRecord) => {
      sql.exec(
        "INSERT INTO account_sessions VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET value = excluded.value",
        session.sessionId,
        canonicalJson(session),
      );
      return session;
    };
    const c = request.command;
    switch (c.kind) {
      case "read":
        return { state };
      case "create": {
        if (state) return { state, created: false };
        return { state: save(c.state), created: true };
      }
      case "touch": {
        if (!state || state.pending || state.epoch !== c.epoch)
          throw new Error("Email mapping changed");
        return { state: save({ ...state, lastSignInAt: c.now, updatedAt: c.now }) };
      }
      case "begin-email": {
        const previous = sql
          .exec<{ requested: string | null }>(
            "SELECT requested FROM email_operations WHERE operation_id = ?",
            c.operationId,
          )
          .toArray()[0];
        if (previous) {
          if (previous.requested !== c.email) throw new Error("Email operation intent mismatch");
          return { state };
        }
        if (state?.pending) return { state };
        sql.exec("INSERT INTO email_operations VALUES (?, ?)", c.operationId, c.email);
        const epoch = (state?.epoch ?? 0) + 1;
        return {
          state: save({
            userId: state?.userId ?? c.userId,
            email: state?.email ?? null,
            mapping: state?.mapping ?? null,
            epoch,
            createdAt: state?.createdAt ?? c.now,
            updatedAt: c.now,
            lastSignInAt: state?.lastSignInAt ?? null,
            pending: {
              operationId: c.operationId,
              requested: c.email,
              old: state?.mapping ?? null,
              epoch,
              phase: "claim",
            },
          }),
        };
      }
      case "commit-email": {
        if (
          !state ||
          state.pending?.operationId !== c.operationId ||
          state.pending.phase !== "claim"
        )
          return { state };
        if (
          c.mapping &&
          (c.mapping.operationId !== c.operationId ||
            c.mapping.accountEpoch !== state.epoch ||
            c.mapping.email !== state.pending.requested)
        )
          throw new Error("Email commit mismatch");
        return {
          state: save({
            ...state,
            email: c.mapping?.email ?? null,
            mapping: c.mapping,
            updatedAt: c.now,
            pending: { ...state.pending, phase: "release" },
          }),
        };
      }
      case "finish-email": {
        if (
          !state ||
          state.pending?.operationId !== c.operationId ||
          state.pending.phase !== "release"
        )
          return { state };
        return { state: save({ ...state, pending: null }) };
      }
      case "open-session": {
        const existing = read<SessionRecord>(
          storage,
          "account_sessions",
          "session_id = ?",
          c.session.sessionId,
        );
        if (existing) {
          const {
            published: _p,
            revoked: _r,
            accountEpoch: _epoch,
            lastUsedAt: _u,
            expiresAt: _e,
            ...original
          } = existing;
          const {
            published: _np,
            revoked: _nr,
            lastUsedAt: _nu,
            expiresAt: _ne,
            ...incoming
          } = c.session;
          if (canonicalJson(original) !== canonicalJson(incoming))
            throw new Error("Session intent mismatch");
          return { session: existing };
        }
        if (!state || state.pending) throw new Error("Account absent or identity pending");
        return {
          session: saveSession({
            ...c.session,
            accountEpoch: state.epoch,
            published: false,
            revoked: false,
          }),
        };
      }
      case "publish-session": {
        const session = read<SessionRecord>(
          storage,
          "account_sessions",
          "session_id = ?",
          c.sessionId,
        );
        if (!session || session.revoked) return { session: null };
        if (
          !session.published &&
          (!state || state.pending || session.accountEpoch !== state.epoch)
        ) {
          saveSession({ ...session, revoked: true });
          return { session: null };
        }
        return { session: saveSession({ ...session, published: true }) };
      }
      case "session":
        return {
          session: read<SessionRecord>(storage, "account_sessions", "session_id = ?", c.sessionId),
        };
      case "use-session": {
        const session = read<SessionRecord>(
          storage,
          "account_sessions",
          "session_id = ?",
          c.sessionId,
        );
        if (
          !state ||
          !session ||
          !session.published ||
          session.revoked ||
          session.expiresAt <= c.now ||
          session.thumbprint !== c.thumbprint ||
          session.tokenHash !== c.tokenHash
        )
          return { session: null };
        if (c.revoke) return { session: saveSession({ ...session, revoked: true }) };
        return {
          session:
            session.lastUsedAt <= c.cutoff
              ? saveSession({ ...session, lastUsedAt: c.now, expiresAt: c.expiresAt })
              : session,
        };
      }
      case "revoke-session": {
        const session = read<SessionRecord>(
          storage,
          "account_sessions",
          "session_id = ?",
          c.sessionId,
        );
        if (!session || session.revoked) return { revoked: false };
        saveSession({ ...session, revoked: true });
        return { revoked: true };
      }
      case "list-sessions":
        return {
          sessions: sql
            .exec<{ value: string }>(
              "SELECT value FROM account_sessions ORDER BY json_extract(value, '$.lastUsedAt') DESC",
            )
            .toArray()
            .map((row) => JSON.parse(row.value) as StoredSession)
            .filter((row) => row.published && !row.revoked && row.expiresAt > c.now),
        };
      case "prune-sessions": {
        sql.exec(
          "UPDATE account_sessions SET value = json_set(value, '$.revoked', json('true')) WHERE json_extract(value, '$.expiresAt') <= ?",
          c.now,
        );
        return {};
      }
    }
  });
}
function read<T>(
  storage: DurableObjectStorage,
  table: string,
  where: string,
  ...args: string[]
): T | null {
  const row = storage.sql
    .exec<{ value: string }>(`SELECT value FROM ${table} WHERE ${where}`, ...args)
    .toArray()[0];
  return row ? (JSON.parse(row.value) as T) : null;
}
export function identityInventory(storage: DurableObjectStorage) {
  return [
    ...["account_identity", "account_sessions"].map((table) =>
      summarize(
        table,
        storage.sql
          .exec<{ value: string }>(`SELECT value FROM ${table} ORDER BY value`)
          .toArray()
          .map((row) => JSON.parse(row.value)),
      ),
    ),
    summarize(
      "email_operations",
      storage.sql.exec("SELECT * FROM email_operations ORDER BY operation_id"),
    ),
  ];
}
