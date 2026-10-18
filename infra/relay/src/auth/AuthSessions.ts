import type { RelayPublicClientId } from "@t3tools/contracts/relay";
import { and, desc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as RelayDb from "../db.ts";
import * as LiveActivityCleanup from "../agentActivity/LiveActivityCleanup.ts";
import { persistenceCause } from "./persistenceCause.ts";
import {
  relayAuthSessions,
  relayLiveActivities,
  relayMobileDevices,
} from "../persistence/schema.ts";

/** A session ends after this long without a refresh. */
export const AUTH_SESSION_IDLE_DAYS = 90;
/** Refreshes inside this window of the last recorded use skip the write. */
const LAST_USED_RESOLUTION_HOURS = 24;

const SESSION_TOKEN_PATTERN = /^styal_rt_([0-9a-f]{32})_([0-9a-f]{64})$/;

export class AuthSessionPersistenceError extends Schema.TaggedError<AuthSessionPersistenceError>()(
  "AuthSessionPersistenceError",
  {
    operation: Schema.Literals(["create", "authenticate", "revoke", "list", "prune-expired"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Relay auth session '${this.operation}' failed`;
  }
}

export interface AuthSession {
  readonly sessionId: string;
  readonly userId: string;
  readonly clientId: RelayPublicClientId;
  readonly label: string | null;
  readonly createdAt: string;
  readonly lastUsedAt: string;
}

export class AuthSessions extends Context.Service<
  AuthSessions,
  {
    readonly create: (input: {
      readonly userId: string;
      readonly clientId: RelayPublicClientId;
      readonly thumbprint: string;
      readonly label?: string;
    }) => Effect.Effect<
      { readonly sessionId: string; readonly token: string },
      AuthSessionPersistenceError
    >;
    /**
     * Resolves a session credential presented with a proof from `thumbprint`
     * and extends its idle expiry. None when the token is unknown, expired or
     * bound to another key.
     */
    readonly authenticate: (input: {
      readonly token: string;
      readonly thumbprint: string;
    }) => Effect.Effect<Option.Option<AuthSession>, AuthSessionPersistenceError>;
    /** Deletes the session the token belongs to. Idempotent. */
    readonly revokeByToken: (input: {
      readonly token: string;
      readonly thumbprint: string;
    }) => Effect.Effect<void, AuthSessionPersistenceError>;
    readonly revoke: (input: {
      readonly userId: string;
      readonly sessionId: string;
    }) => Effect.Effect<boolean, AuthSessionPersistenceError>;
    /**
     * Whether the user's session still exists and has not expired. Access
     * tokens carry their session id, so revoking a session ends them too.
     */
    readonly isLive: (input: {
      readonly userId: string;
      readonly sessionId: string;
    }) => Effect.Effect<boolean, AuthSessionPersistenceError>;
    readonly listForUser: (
      userId: string,
    ) => Effect.Effect<ReadonlyArray<AuthSession>, AuthSessionPersistenceError>;
    readonly pruneExpired: Effect.Effect<void, AuthSessionPersistenceError>;
  }
>()("t3code-relay/auth/AuthSessions") {}

export function parseSessionToken(
  token: string,
): { readonly sessionId: string; readonly secret: string } | null {
  const match = SESSION_TOKEN_PATTERN.exec(token);
  return match?.[1] && match[2] ? { sessionId: match[1], secret: match[2] } : null;
}

/** Whether a session last used at `lastUsedAt` should have its use recorded again at `now`. */
export function shouldRecordUse(lastUsedAt: string, now: DateTime.Utc): boolean {
  return (
    lastUsedAt <= DateTime.formatIso(DateTime.subtract(now, { hours: LAST_USED_RESOLUTION_HOURS }))
  );
}

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const sessionColumns = {
  sessionId: relayAuthSessions.sessionId,
  userId: relayAuthSessions.userId,
  clientId: relayAuthSessions.clientId,
  label: relayAuthSessions.label,
  createdAt: relayAuthSessions.createdAt,
  lastUsedAt: relayAuthSessions.lastUsedAt,
};

const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const crypto = yield* Crypto.Crypto;
  const cleanup = yield* LiveActivityCleanup.make;
  const hashToken = (token: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(token)).pipe(Effect.map(Base64Url.encode));

  // Only the session id and token hash identify the row; the thumbprint must
  // match too, so a copied token is useless without the device's key.
  const findLive = Effect.fnUntraced(function* (token: string, thumbprint: string) {
    const parsed = parseSessionToken(token);
    if (!parsed) return Option.none();
    const rows = yield* db
      .select({
        ...sessionColumns,
        thumbprint: relayAuthSessions.thumbprint,
        tokenHash: relayAuthSessions.tokenHash,
        expiresAt: relayAuthSessions.expiresAt,
      })
      .from(relayAuthSessions)
      .where(eq(relayAuthSessions.sessionId, parsed.sessionId))
      .limit(1);
    const row = rows[0];
    const now = yield* DateTime.now;
    if (
      !row ||
      row.thumbprint !== thumbprint ||
      row.tokenHash !== (yield* hashToken(token)) ||
      row.expiresAt <= DateTime.formatIso(now)
    ) {
      return Option.none();
    }
    return Option.some({ row, now });
  });

  const sessionDevices = (userId: string, sessionId: string) =>
    and(eq(relayMobileDevices.userId, userId), eq(relayMobileDevices.sessionId, sessionId))!;

  // Called inside the transaction that deletes the sessions, after the
  // session rows are locked. Legacy NULL ownership is kept; matching both
  // account and device avoids other users.
  const deleteSessionDevices = Effect.fnUntraced(function* (sessionIds: ReadonlyArray<string>) {
    if (sessionIds.length === 0) return;
    yield* db.delete(relayLiveActivities).where(sql`exists (
      select 1 from ${relayMobileDevices}
      where ${relayMobileDevices.userId} = ${relayLiveActivities.userId}
        and ${relayMobileDevices.deviceId} = ${relayLiveActivities.deviceId}
        and ${inArray(relayMobileDevices.sessionId, sessionIds)}
    )`);
    yield* db.delete(relayMobileDevices).where(inArray(relayMobileDevices.sessionId, sessionIds));
  });

  // Deleting the session row locks it, which waits for an in-flight
  // registration and blocks new ones, before `confirm` checks the queued ends.
  const revokeSession = (userId: string, sessionId: string) =>
    cleanup.removeAfterEnds(sessionDevices(userId, sessionId), (confirm) =>
      db.$client.withTransaction(
        Effect.gen(function* () {
          const deleted = yield* db
            .delete(relayAuthSessions)
            .where(
              and(eq(relayAuthSessions.userId, userId), eq(relayAuthSessions.sessionId, sessionId)),
            )
            .returning({ sessionId: relayAuthSessions.sessionId });
          if (deleted.length === 0) return false;
          yield* confirm;
          yield* deleteSessionDevices([sessionId]);
          return true;
        }),
      ),
    );

  return AuthSessions.of({
    create: Effect.fn("relay.auth_sessions.create")(
      function* (input) {
        const sessionId = toHex(yield* crypto.randomBytes(16));
        const token = `styal_rt_${sessionId}_${toHex(yield* crypto.randomBytes(32))}`;
        const now = yield* DateTime.now;
        yield* db.insert(relayAuthSessions).values({
          sessionId,
          userId: input.userId,
          clientId: input.clientId,
          thumbprint: input.thumbprint,
          tokenHash: yield* hashToken(token),
          label: input.label ?? null,
          lastUsedAt: DateTime.formatIso(now),
          expiresAt: DateTime.formatIso(DateTime.add(now, { days: AUTH_SESSION_IDLE_DAYS })),
          createdAt: DateTime.formatIso(now),
        });
        yield* Effect.annotateCurrentSpan({ "relay.auth.session_id": sessionId });
        return { sessionId, token };
      },
      Effect.mapError(
        (cause) =>
          new AuthSessionPersistenceError({ operation: "create", cause: persistenceCause(cause) }),
      ),
    ),

    authenticate: Effect.fn("relay.auth_sessions.authenticate")(
      function* (input) {
        const live = yield* findLive(input.token, input.thumbprint);
        if (Option.isNone(live)) return Option.none();
        const { row, now } = live.value;
        let lastUsedAt = row.lastUsedAt;
        if (shouldRecordUse(row.lastUsedAt, now)) {
          lastUsedAt = DateTime.formatIso(now);
          yield* db
            .update(relayAuthSessions)
            .set({
              lastUsedAt,
              expiresAt: DateTime.formatIso(DateTime.add(now, { days: AUTH_SESSION_IDLE_DAYS })),
            })
            .where(eq(relayAuthSessions.sessionId, row.sessionId));
        }
        yield* Effect.annotateCurrentSpan({ "relay.auth.session_id": row.sessionId });
        return Option.some({
          sessionId: row.sessionId,
          userId: row.userId,
          clientId: row.clientId,
          label: row.label,
          createdAt: row.createdAt,
          lastUsedAt,
        });
      },
      Effect.mapError(
        (cause) =>
          new AuthSessionPersistenceError({
            operation: "authenticate",
            cause: persistenceCause(cause),
          }),
      ),
    ),

    revokeByToken: Effect.fn("relay.auth_sessions.revoke_by_token")(
      function* (input) {
        const live = yield* findLive(input.token, input.thumbprint);
        if (Option.isNone(live)) return;
        yield* revokeSession(live.value.row.userId, live.value.row.sessionId);
      },
      Effect.mapError(
        (cause) =>
          new AuthSessionPersistenceError({ operation: "revoke", cause: persistenceCause(cause) }),
      ),
    ),

    revoke: Effect.fn("relay.auth_sessions.revoke")(
      function* (input) {
        return yield* revokeSession(input.userId, input.sessionId);
      },
      Effect.mapError(
        (cause) =>
          new AuthSessionPersistenceError({ operation: "revoke", cause: persistenceCause(cause) }),
      ),
    ),

    isLive: Effect.fn("relay.auth_sessions.is_live")(
      function* (input) {
        const now = DateTime.formatIso(yield* DateTime.now);
        const rows = yield* db
          .select({ sessionId: relayAuthSessions.sessionId })
          .from(relayAuthSessions)
          .where(
            and(
              eq(relayAuthSessions.sessionId, input.sessionId),
              eq(relayAuthSessions.userId, input.userId),
              gt(relayAuthSessions.expiresAt, now),
            ),
          )
          .limit(1);
        return rows.length > 0;
      },
      Effect.mapError(
        (cause) =>
          new AuthSessionPersistenceError({
            operation: "authenticate",
            cause: persistenceCause(cause),
          }),
      ),
    ),

    listForUser: Effect.fn("relay.auth_sessions.list_for_user")(
      function* (userId) {
        const now = DateTime.formatIso(yield* DateTime.now);
        const rows = yield* db
          .select({ ...sessionColumns, expiresAt: relayAuthSessions.expiresAt })
          .from(relayAuthSessions)
          .where(eq(relayAuthSessions.userId, userId))
          .orderBy(desc(relayAuthSessions.lastUsedAt));
        return rows
          .filter((row) => row.expiresAt > now)
          .map(({ expiresAt: _expiresAt, ...session }) => session);
      },
      Effect.mapError(
        (cause) =>
          new AuthSessionPersistenceError({ operation: "list", cause: persistenceCause(cause) }),
      ),
    ),

    pruneExpired: Effect.gen(function* () {
      const now = DateTime.formatIso(yield* DateTime.now);
      // An expired session cannot be refreshed, so the set read here is the
      // set the transaction deletes, apart from concurrent revocations.
      const expired = yield* db
        .select({ sessionId: relayAuthSessions.sessionId })
        .from(relayAuthSessions)
        .where(lte(relayAuthSessions.expiresAt, now));
      if (expired.length === 0) return;
      const sessionIds = expired.map((row) => row.sessionId);
      yield* cleanup.removeAfterEnds(inArray(relayMobileDevices.sessionId, sessionIds), (confirm) =>
        db.$client.withTransaction(
          Effect.gen(function* () {
            const deleted = yield* db
              .delete(relayAuthSessions)
              .where(
                and(
                  inArray(relayAuthSessions.sessionId, sessionIds),
                  lte(relayAuthSessions.expiresAt, now),
                ),
              )
              .returning({ sessionId: relayAuthSessions.sessionId });
            yield* confirm;
            yield* deleteSessionDevices(deleted.map((row) => row.sessionId));
          }),
        ),
      );
    }).pipe(
      Effect.mapError(
        (cause) =>
          new AuthSessionPersistenceError({
            operation: "prune-expired",
            cause: persistenceCause(cause),
          }),
      ),
      Effect.withSpan("relay.auth_sessions.prune_expired"),
    ),
  });
});

export const layer = Layer.effect(AuthSessions, make);
