import type { RelayPublicClientId } from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { SessionPersistence } from "../persistence/IdentityPersistence.ts";

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

export const layer = Layer.effect(
  AuthSessions,
  Effect.map(SessionPersistence, (store) => AuthSessions.of(store)),
);
