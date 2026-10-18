import {
  RelayApi,
  RelayAuthInvalidError,
  RelayAuthRateLimitedError,
  RelayCliClientId,
  RelayEmailSignInUnavailableError,
  RelaySignInCodeInvalidError,
  type RelayEmailSignInStartResponse,
} from "@t3tools/contracts/relay";
import {
  DpopPrivateJwk,
  generateDpopPrivateJwk,
  importDpopProofKey,
  signDpopProof,
  type DpopProofKey,
} from "@t3tools/shared/dpopProof";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { SecretStoreLockError, withSecretStoreLock } from "../auth/SecretStoreLock.ts";
import { legacyClerkCliConfig, relayUrlConfig } from "./publicConfig.ts";

/** The CLI's P-256 DPoP key. Relay sessions only accept proofs from it. */
export const CLOUD_CLI_DPOP_KEY_SECRET = "cloud-cli-dpop-key";
/** The relay session `styal link login` stores, shared with the server on this machine. */
export const CLOUD_RELAY_SESSION_SECRET = "cloud-relay-session";
/** Clerk OAuth token retained for older CLIs until explicit logout. */
export const LEGACY_CLERK_CLI_TOKEN_SECRET = "cloud-cli-oauth-token";
/** Prevents retained Clerk credentials from re-adopting an ended relay session. */
const LEGACY_CLERK_ADOPTED_SECRET = "cloud-cli-clerk-adopted";

// Access tokens live 30 minutes; refresh a little early so a proof never
// carries a token that expires in flight.
const ACCESS_TOKEN_REFRESH_EARLY_MS = Duration.toMillis(Duration.minutes(2));
const LEGACY_CLERK_REFRESH_EARLY_MS = Duration.toMillis(Duration.minutes(5));
const SESSION_LABEL_MAX_LENGTH = 120;

const PersistedRelaySession = Schema.Struct({
  refreshToken: Schema.String,
  sessionId: Schema.String,
  userId: Schema.String,
  email: Schema.NullOr(Schema.String),
  relayUrl: Schema.String,
});
type PersistedRelaySession = typeof PersistedRelaySession.Type;
const PersistedRelaySessionJson = Schema.fromJsonString(PersistedRelaySession);
const decodePersistedRelaySession = Schema.decodeUnknownOption(PersistedRelaySessionJson);
const encodePersistedRelaySession = Schema.encodeSync(PersistedRelaySessionJson);

const DpopPrivateJwkJson = Schema.fromJsonString(DpopPrivateJwk);
const decodeDpopPrivateJwk = Schema.decodeUnknownOption(DpopPrivateJwkJson);
const encodeDpopPrivateJwk = Schema.encodeSync(DpopPrivateJwkJson);

const LegacyClerkToken = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.String,
  expiresAtEpochMs: Schema.Number,
  identity: Schema.optional(Schema.String),
});
type LegacyClerkToken = typeof LegacyClerkToken.Type;
const LegacyClerkTokenJson = Schema.fromJsonString(LegacyClerkToken);
const decodeLegacyClerkToken = Schema.decodeUnknownOption(LegacyClerkTokenJson);
const encodeLegacyClerkToken = Schema.encodeSync(LegacyClerkTokenJson);

const ClerkTokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.Number,
});
const ClerkTokenError = Schema.Struct({ error: Schema.String });

export interface CloudCliIdentity {
  readonly userId: string;
  /** Null for accounts migrated from Clerk whose email the relay never learned. */
  readonly email: string | null;
  readonly relayUrl: string;
}

/** Headers for a relay `client` request: the access token and a proof bound to it. */
export interface CloudCliAuthorizationHeaders {
  readonly authorization: string;
  readonly dpop: string;
}

export class CloudCliSessionStorageError extends Schema.TaggedError<CloudCliSessionStorageError>()(
  "CloudCliSessionStorageError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    if (isSecretStoreLockError(this.cause) && this.cause.reason === "busy") {
      return "Another styal process is updating the styal Link sign-in; try again.";
    }
    return "Could not read or update the stored styal Link sign-in.";
  }
}

/** The relay could not be reached or failed; the stored session is kept. */
export class CloudCliRelayUnavailableError extends Schema.TaggedError<CloudCliRelayUnavailableError>()(
  "CloudCliRelayUnavailableError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not reach the styal Link relay. Check this machine's network connection, then retry.";
  }
}

export class CloudCliRelayRejectedError extends Schema.TaggedError<CloudCliRelayRejectedError>()(
  "CloudCliRelayRejectedError",
  { description: Schema.String },
) {
  override get message(): string {
    return `The styal Link relay refused the request: ${this.description}`;
  }
}

export class CloudCliClerkRefreshRejectedError extends Schema.TaggedError<CloudCliClerkRefreshRejectedError>()(
  "CloudCliClerkRefreshRejectedError",
  { status: Schema.Number },
) {
  override get message(): string {
    return `Clerk refused to refresh the stored sign-in (HTTP ${this.status}). Sign in again with an emailed code.`;
  }
}

export class CloudCliDpopKeyError extends Schema.TaggedError<CloudCliDpopKeyError>()(
  "CloudCliDpopKeyError",
  {},
) {
  override get message(): string {
    return "The stored styal Link proof key is unreadable. Retry after any other sign-in finishes. If this persists, stop other styal processes sharing this home directory, run `styal link logout`, then `styal link login` with the same home directory.";
  }
}

export class CloudCliSignInCodeError extends Schema.TaggedError<CloudCliSignInCodeError>()(
  "CloudCliSignInCodeError",
  { reason: Schema.Literals(["incorrect", "expired", "too_many_attempts"]) },
) {
  override get message(): string {
    switch (this.reason) {
      case "incorrect":
        return "That code is not correct.";
      case "expired":
        return "That code has expired.";
      case "too_many_attempts":
        return "Too many incorrect codes.";
    }
  }
}

export class CloudCliSignInRateLimitedError extends Schema.TaggedError<CloudCliSignInRateLimitedError>()(
  "CloudCliSignInRateLimitedError",
  { retryAfterSeconds: Schema.Number },
) {
  override get message(): string {
    return `Too many sign-in attempts. Try again in ${this.retryAfterSeconds} seconds.`;
  }
}

export class CloudCliEmailSignInUnavailableError extends Schema.TaggedError<CloudCliEmailSignInUnavailableError>()(
  "CloudCliEmailSignInUnavailableError",
  { reason: Schema.Literals(["not_configured", "delivery_failed"]) },
) {
  override get message(): string {
    return this.reason === "not_configured"
      ? "This styal Link relay does not offer email sign-in yet."
      : "The styal Link relay could not send the sign-in email. Try again later.";
  }
}

export class CloudCliRelayConfigError extends Schema.TaggedError<CloudCliRelayConfigError>()(
  "CloudCliRelayConfigError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "No styal Link relay is configured for this build. Set T3CODE_RELAY_URL.";
  }
}

export class CloudCliLegacyClerkConfigError extends Schema.TaggedError<CloudCliLegacyClerkConfigError>()(
  "CloudCliLegacyClerkConfigError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "The stored Clerk sign-in needs the legacy Clerk configuration to migrate. Restore T3CODE_CLERK_PUBLISHABLE_KEY and T3CODE_CLERK_CLI_OAUTH_CLIENT_ID, then retry.";
  }
}

export const CloudCliSessionError = Schema.Union([
  CloudCliSessionStorageError,
  CloudCliRelayUnavailableError,
  CloudCliRelayRejectedError,
  CloudCliClerkRefreshRejectedError,
  CloudCliDpopKeyError,
  CloudCliSignInCodeError,
  CloudCliSignInRateLimitedError,
  CloudCliEmailSignInUnavailableError,
  CloudCliRelayConfigError,
  CloudCliLegacyClerkConfigError,
]);
export type CloudCliSessionError = typeof CloudCliSessionError.Type;

export type CloudCliSignOutResult = "revoked" | "not-signed-in" | "revoke-failed";

export class CloudCliSession extends Context.Service<
  CloudCliSession,
  {
    /** Emails a sign-in code. The same DPoP key must redeem it. */
    readonly startEmailSignIn: (
      email: string,
    ) => Effect.Effect<RelayEmailSignInStartResponse, CloudCliSessionError>;
    /** Redeems a code and stores the resulting session, replacing any previous one. */
    readonly verifyEmailSignIn: (input: {
      readonly email: string;
      readonly code: string;
    }) => Effect.Effect<CloudCliIdentity, CloudCliSessionError>;
    /**
     * The signed-in account, after confirming the session with the relay.
     * None when signed out or when the relay ended the session.
     */
    readonly currentIdentity: Effect.Effect<Option.Option<CloudCliIdentity>, CloudCliSessionError>;
    /** The stored account without contacting the relay. */
    readonly storedIdentity: Effect.Effect<Option.Option<CloudCliIdentity>, CloudCliSessionError>;
    /** Whether a relay session or a not-yet-adopted Clerk credential is stored. */
    readonly hasCredential: Effect.Effect<boolean, CloudCliSessionError>;
    /** Headers for one relay request. None when signed out. */
    readonly authorize: (
      method: string,
      url: string,
    ) => Effect.Effect<Option.Option<CloudCliAuthorizationHeaders>, CloudCliSessionError>;
    /** Ends the session at the relay (best effort) and removes it locally. */
    readonly signOut: Effect.Effect<CloudCliSignOutResult, CloudCliSessionError>;
  }
>()("@styal/cli/cloud/CliSession/CloudCliSession") {}

function bytesToString(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

function stringToBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

const storageError = (cause: unknown) => new CloudCliSessionStorageError({ cause });

const isCloudCliSessionError = Schema.is(CloudCliSessionError);
const isRelaySignInCodeInvalidError = Schema.is(RelaySignInCodeInvalidError);
const isRelayAuthRateLimitedError = Schema.is(RelayAuthRateLimitedError);
const isRelayEmailSignInUnavailableError = Schema.is(RelayEmailSignInUnavailableError);
const isRelayAuthInvalidError = Schema.is(RelayAuthInvalidError);
const isSecretStoreLockError = Schema.is(SecretStoreLockError);

function nonRetryableHttpStatus(cause: unknown): number | undefined {
  const status = HttpClientError.isHttpClientError(cause) ? cause.response?.status : undefined;
  return status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429
    ? status
    : undefined;
}

const preserveHttpRefusal = <A, E, R>(response: Effect.Effect<A, E, R>) =>
  response.pipe(
    Effect.catchCause((cause) => {
      // An unfamiliar 4xx body can fail both status and schema decoding.
      // Keep its refusal instead of retrying the accompanying decode error.
      const refusal = cause.reasons.find(
        (reason) => reason._tag === "Fail" && nonRetryableHttpStatus(reason.error) !== undefined,
      );
      return refusal?._tag === "Fail" ? Effect.fail(refusal.error) : Effect.failCause(cause);
    }),
  );

/** Maps a failed relay `auth` request. Refusals keep their reason; anything else may pass on retry. */
function relayAuthFailure(cause: unknown): CloudCliSessionError {
  if (isCloudCliSessionError(cause)) return cause;
  if (isRelaySignInCodeInvalidError(cause)) {
    return new CloudCliSignInCodeError({ reason: cause.reason });
  }
  if (isRelayAuthRateLimitedError(cause)) {
    return new CloudCliSignInRateLimitedError({ retryAfterSeconds: cause.retryAfterSeconds });
  }
  if (isRelayEmailSignInUnavailableError(cause)) {
    return new CloudCliEmailSignInUnavailableError({ reason: cause.reason });
  }
  if (isRelayAuthInvalidError(cause)) {
    return new CloudCliRelayRejectedError({
      description:
        cause.reason === "invalid_dpop"
          ? `${cause.message}. Check that this machine's system clock is correct.`
          : cause.message,
    });
  }
  const status = nonRetryableHttpStatus(cause);
  if (status !== undefined) {
    return new CloudCliRelayRejectedError({
      description: `HTTP ${status}.`,
    });
  }
  return new CloudCliRelayUnavailableError({ cause });
}

function sessionLabel(hostname: string): string {
  const label = hostname.trim() ? `styal CLI on ${hostname.trim()}` : "styal CLI";
  return label.slice(0, SESSION_LABEL_MAX_LENGTH);
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const httpClient = yield* HttpClient.HttpClient;
  const crypto = yield* Crypto.Crypto;
  const semaphore = yield* Semaphore.make(1);

  let cachedKey: { readonly encoded: string; readonly key: DpopProofKey } | undefined;
  let cachedAccessToken:
    | {
        readonly refreshToken: string;
        readonly accessToken: string;
        readonly expiresAtEpochMs: number;
      }
    | undefined;

  const relayClient = (relayUrl: string) =>
    HttpApiClient.make(RelayApi, {
      baseUrl: relayUrl,
      transformResponse: preserveHttpRefusal,
    }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
  const authUrls = (relayUrl: string) => HttpApiClient.urlBuilder(RelayApi, { baseUrl: relayUrl });

  const configuredRelayUrl = relayUrlConfig.pipe(
    Effect.mapError((cause) => new CloudCliRelayConfigError({ cause })),
  );

  const readSecretString = (name: string) =>
    secrets.get(name).pipe(Effect.map(Option.map(bytesToString)), Effect.mapError(storageError));
  const writeSecretString = (name: string, value: string) =>
    secrets.set(name, stringToBytes(value)).pipe(Effect.mapError(storageError));
  const removeSecret = (name: string) => secrets.remove(name).pipe(Effect.mapError(storageError));
  const withCredentialLock = <A, E, R>(task: Effect.Effect<A, E, R>) =>
    withSecretStoreLock(secrets.directory, "cloud-cli-session", task).pipe(
      Effect.mapError((cause) => (isSecretStoreLockError(cause) ? storageError(cause) : cause)),
    );
  // Older versions do not take our lease. Do not remove a token they replaced
  // while our refresh or relay request was in flight.
  const forgetLegacyCredential = Effect.fnUntraced(function* (rejected: string) {
    const current = yield* readSecretString(LEGACY_CLERK_CLI_TOKEN_SECRET);
    if (Option.isSome(current) && current.value === rejected) {
      yield* removeSecret(LEGACY_CLERK_CLI_TOKEN_SECRET);
    }
  });

  const importKey = Effect.fn("cloud.cli_session.import_key")(function* (encoded: string) {
    if (cachedKey?.encoded === encoded) return Option.some(cachedKey.key);
    const jwk = decodeDpopPrivateJwk(encoded);
    if (Option.isNone(jwk)) return Option.none<DpopProofKey>();
    const key = yield* importDpopProofKey(jwk.value).pipe(Effect.option);
    if (Option.isNone(key)) return Option.none<DpopProofKey>();
    cachedKey = { encoded, key: key.value };
    return key;
  });

  const readKey = readSecretString(CLOUD_CLI_DPOP_KEY_SECRET).pipe(
    Effect.flatMap(
      Option.match({ onNone: () => Effect.succeedNone, onSome: (encoded) => importKey(encoded) }),
    ),
  );

  /** The stored key, or a new one. Concurrent creators converge on the first write. */
  const getOrCreateKey = Effect.gen(function* () {
    const stored = yield* readSecretString(CLOUD_CLI_DPOP_KEY_SECRET);
    const existing = Option.isSome(stored) ? yield* importKey(stored.value) : Option.none();
    if (Option.isSome(existing)) return existing.value;
    // An older process may still be writing its first key. Never replace it,
    // or a persisted session could become bound to a key that no longer exists.
    if (Option.isSome(stored)) {
      return yield* new CloudCliDpopKeyError();
    }
    const generated = yield* generateDpopPrivateJwk.pipe(Effect.mapError(storageError));
    const encoded = encodeDpopPrivateJwk(generated);
    const created = yield* secrets.create(CLOUD_CLI_DPOP_KEY_SECRET, stringToBytes(encoded)).pipe(
      Effect.as(true),
      Effect.catchIf(ServerSecretStore.isSecretAlreadyExistsError, () => Effect.succeed(false)),
      Effect.mapError(storageError),
    );
    if (created) {
      return Option.getOrThrow(yield* importKey(encoded));
    }
    const raced = yield* readKey;
    if (Option.isNone(raced)) {
      return yield* new CloudCliDpopKeyError();
    }
    return raced.value;
  });

  const proofFor = (input: {
    readonly key: DpopProofKey;
    readonly method: string;
    readonly url: string;
    readonly accessToken?: string;
  }) =>
    signDpopProof(input).pipe(
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.mapError(storageError),
    );

  const readSession = readSecretString(CLOUD_RELAY_SESSION_SECRET).pipe(
    Effect.map(Option.flatMap(decodePersistedRelaySession)),
  );

  const persistSession = (session: PersistedRelaySession) =>
    writeSecretString(CLOUD_RELAY_SESSION_SECRET, encodePersistedRelaySession(session));

  const label = Effect.gen(function* () {
    return sessionLabel(yield* HostProcess.Hostname);
  });

  const rememberAccessToken = Effect.fn("cloud.cli_session.remember_access_token")(function* (
    refreshToken: string,
    response: { readonly access_token: string; readonly expires_in: number },
  ) {
    const now = yield* Clock.currentTimeMillis;
    cachedAccessToken = {
      refreshToken,
      accessToken: response.access_token,
      expiresAtEpochMs: now + response.expires_in * 1_000,
    };
    return response.access_token;
  });

  const storeSignedInSession = Effect.fn("cloud.cli_session.store_signed_in_session")(function* (
    relayUrl: string,
    response: {
      readonly access_token: string;
      readonly expires_in: number;
      readonly refresh_token: string;
      readonly session_id: string;
      readonly user: { readonly id: string; readonly email: string | null };
    },
  ) {
    const session: PersistedRelaySession = {
      refreshToken: response.refresh_token,
      sessionId: response.session_id,
      userId: response.user.id,
      email: response.user.email,
      relayUrl,
    };
    yield* persistSession(session);
    // Older servers sharing this home still need Clerk, including its rotated
    // refresh token. Retain it until logout, but never adopt it a second time.
    yield* writeSecretString(LEGACY_CLERK_ADOPTED_SECRET, "1");
    yield* rememberAccessToken(session.refreshToken, response);
    return session;
  });

  const toIdentity = (session: PersistedRelaySession): CloudCliIdentity => ({
    userId: session.userId,
    email: session.email,
    relayUrl: session.relayUrl,
  });

  /** A Clerk access token for the legacy credential, refreshed at Clerk when it is stale. */
  const legacyClerkAccessToken = Effect.fn("cloud.cli_session.legacy_clerk_access_token")(
    function* (legacy: LegacyClerkToken, encoded: string) {
      const now = yield* Clock.currentTimeMillis;
      if (legacy.expiresAtEpochMs - LEGACY_CLERK_REFRESH_EARLY_MS > now) {
        return Option.some({ accessToken: legacy.accessToken, encoded });
      }
      const config = yield* legacyClerkCliConfig.pipe(
        Effect.mapError((cause) => new CloudCliLegacyClerkConfigError({ cause })),
      );
      const body = yield* Effect.gen(function* () {
        const response = yield* HttpClientRequest.post(config.tokenEndpoint).pipe(
          HttpClientRequest.bodyUrlParams({
            grant_type: "refresh_token",
            refresh_token: legacy.refreshToken,
            client_id: config.clientId,
          }),
          httpClient.execute,
        );
        if (response.status >= 400 && response.status < 500) {
          const refusal = yield* HttpClientResponse.schemaBodyJson(ClerkTokenError)(response).pipe(
            Effect.option,
          );
          if (response.status !== 408 && response.status !== 429) {
            if (
              Option.isSome(refusal) &&
              (refusal.value.error === "invalid_grant" || refusal.value.error === "revoked")
            ) {
              return Option.none();
            }
            return yield* new CloudCliClerkRefreshRejectedError({
              status: response.status,
            });
          }
          return yield* new CloudCliRelayUnavailableError({ cause: response });
        }
        return yield* HttpClientResponse.filterStatusOk(response).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(ClerkTokenResponse)),
          Effect.asSome,
        );
      }).pipe(Effect.timeout("15 seconds"), Effect.mapError(relayAuthFailure));
      if (Option.isNone(body)) return Option.none();
      // Clerk rotates refresh tokens. Keep the new one in case the exchange
      // below fails and adoption has to run again.
      const refreshedAt = yield* Clock.currentTimeMillis;
      const refreshed = encodeLegacyClerkToken({
        ...legacy,
        accessToken: body.value.access_token,
        refreshToken: body.value.refresh_token ?? legacy.refreshToken,
        expiresAtEpochMs: refreshedAt + body.value.expires_in * 1_000,
      });
      const current = yield* readSecretString(LEGACY_CLERK_CLI_TOKEN_SECRET);
      if (Option.isNone(current) || current.value !== encoded) {
        return yield* storageError(
          new Error("The legacy Clerk credential changed during refresh."),
        );
      }
      yield* writeSecretString(LEGACY_CLERK_CLI_TOKEN_SECRET, refreshed);
      return Option.some({ accessToken: body.value.access_token, encoded: refreshed });
    },
  );

  /**
   * Converts a Clerk credential stored by an older CLI into a relay session,
   * so background services keep their link across the upgrade without a
   * prompt. Only definitive grant rejections remove the rejected credential.
   */
  const adoptLegacyClerkCredential = Effect.fn("cloud.cli_session.adopt_legacy_clerk_credential")(
    function* () {
      // Another CLI/server may have completed adoption while we waited for
      // the cross-process lease. Re-read both sources inside that lease.
      const session = yield* readSession;
      if (Option.isSome(session)) return session;
      if (Option.isSome(yield* readSecretString(LEGACY_CLERK_ADOPTED_SECRET))) {
        return Option.none<PersistedRelaySession>();
      }
      const encoded = yield* readSecretString(LEGACY_CLERK_CLI_TOKEN_SECRET);
      if (Option.isNone(encoded)) return Option.none<PersistedRelaySession>();
      const legacy = decodeLegacyClerkToken(encoded.value);
      if (Option.isNone(legacy)) {
        return yield* storageError(
          new Error("The stored legacy Clerk credential could not be read."),
        );
      }
      const clerkAccessToken = yield* legacyClerkAccessToken(legacy.value, encoded.value);
      if (Option.isNone(clerkAccessToken)) {
        yield* Effect.logWarning(
          "The stored styal Link CLI credential could not be refreshed; run `styal link login`.",
        );
        yield* forgetLegacyCredential(encoded.value);
        return Option.none<PersistedRelaySession>();
      }
      const relayUrl = yield* configuredRelayUrl;
      const key = yield* getOrCreateKey;
      const client = yield* relayClient(relayUrl);
      const dpop = yield* proofFor({
        key,
        method: "POST",
        url: authUrls(relayUrl).auth.exchangeClerkSession(),
      });
      const exchanged = yield* client.auth
        .exchangeClerkSession({
          headers: { dpop },
          payload: {
            subject_token: clerkAccessToken.value.accessToken,
            client_id: RelayCliClientId,
            label: yield* label,
          },
        })
        .pipe(
          Effect.timeout("15 seconds"),
          Effect.asSome,
          Effect.catchTags({
            RelayAuthInvalidError: (error) =>
              error.reason === "invalid_bearer"
                ? Effect.logWarning("The relay refused the stored styal Link CLI credential.", {
                    reason: error.reason,
                  }).pipe(Effect.as(Option.none()))
                : Effect.fail(error),
          }),
          Effect.mapError(relayAuthFailure),
        );
      if (Option.isNone(exchanged)) {
        yield* forgetLegacyCredential(clerkAccessToken.value.encoded);
        return Option.none<PersistedRelaySession>();
      }
      const adopted = yield* storeSignedInSession(relayUrl, exchanged.value);
      yield* Effect.logInfo("Moved the stored styal Link CLI credential to a relay session.");
      return Option.some(adopted);
    },
    withCredentialLock,
  );

  const loadSession = Effect.gen(function* () {
    const session = yield* readSession;
    if (Option.isSome(session)) return session;
    if (!(yield* hasCredential)) return Option.none<PersistedRelaySession>();
    return yield* adoptLegacyClerkCredential();
  });

  /** Removes the session, unless another process already replaced it. */
  const forgetSession = Effect.fn("cloud.cli_session.forget_session")(function* (
    session: PersistedRelaySession,
  ) {
    cachedAccessToken = undefined;
    const current = yield* readSession;
    if (Option.isSome(current) && current.value.refreshToken === session.refreshToken) {
      yield* writeSecretString(LEGACY_CLERK_ADOPTED_SECRET, "1");
      yield* removeSecret(CLOUD_RELAY_SESSION_SECRET);
    }
  }, withCredentialLock);

  /** Updates the stored email, unless another process already replaced the session. */
  const recordEmail = Effect.fn("cloud.cli_session.record_email")(function* (
    session: PersistedRelaySession,
    email: string | null,
  ) {
    const current = yield* readSession;
    if (Option.isSome(current) && current.value.refreshToken === session.refreshToken) {
      yield* persistSession({ ...current.value, email });
    }
  }, withCredentialLock);

  /** A current access token for the session; None when the relay ended the session. */
  const accessTokenFor = Effect.fn("cloud.cli_session.access_token_for")(function* (
    session: PersistedRelaySession,
    key: DpopProofKey,
  ) {
    const now = yield* Clock.currentTimeMillis;
    if (
      cachedAccessToken?.refreshToken === session.refreshToken &&
      cachedAccessToken.expiresAtEpochMs - ACCESS_TOKEN_REFRESH_EARLY_MS > now
    ) {
      return Option.some(cachedAccessToken.accessToken);
    }
    const client = yield* relayClient(session.relayUrl);
    const dpop = yield* proofFor({
      key,
      method: "POST",
      url: authUrls(session.relayUrl).auth.refreshAuthToken(),
    });
    const refreshed = yield* client.auth
      .refreshAuthToken({ headers: { dpop }, payload: { refresh_token: session.refreshToken } })
      .pipe(
        Effect.timeout("15 seconds"),
        Effect.asSome,
        Effect.catchTags({
          RelayAuthInvalidError: (error) =>
            error.reason === "invalid_session" ? Effect.succeedNone : Effect.fail(error),
        }),
        Effect.mapError(relayAuthFailure),
      );
    if (Option.isNone(refreshed)) {
      yield* Effect.logWarning("styal Link signed this machine out; run `styal link login`.");
      yield* forgetSession(session);
      return Option.none<string>();
    }
    if (refreshed.value.user.email !== session.email) {
      yield* recordEmail(session, refreshed.value.user.email);
    }
    return Option.some(yield* rememberAccessToken(session.refreshToken, refreshed.value));
  });

  /** The session with a valid access token and its proof key, or None when signed out. */
  const activeSession = Effect.gen(function* () {
    const session = yield* loadSession;
    if (Option.isNone(session)) return Option.none();
    if (session.value.relayUrl !== (yield* configuredRelayUrl)) return Option.none();
    const key = yield* readKey;
    if (Option.isNone(key)) {
      // A session is useless without the key it is bound to.
      yield* forgetSession(session.value);
      return Option.none();
    }
    const accessToken = yield* accessTokenFor(session.value, key.value);
    return Option.map(accessToken, (token) => ({
      session: session.value,
      key: key.value,
      accessToken: token,
    }));
  });

  const startEmailSignIn = Effect.fn("cloud.cli_session.start_email_sign_in")(function* (
    email: string,
  ) {
    const relayUrl = yield* configuredRelayUrl;
    const key = yield* getOrCreateKey;
    const client = yield* relayClient(relayUrl);
    const dpop = yield* proofFor({
      key,
      method: "POST",
      url: authUrls(relayUrl).auth.startEmailSignIn(),
    });
    return yield* client.auth
      .startEmailSignIn({ headers: { dpop }, payload: { email, client_id: RelayCliClientId } })
      .pipe(Effect.timeout("15 seconds"), Effect.mapError(relayAuthFailure));
  });

  const signOutSession = Effect.fn("cloud.cli_session.sign_out_session")(function* (
    session: PersistedRelaySession,
  ) {
    const key = yield* readKey;
    if (Option.isNone(key)) return false;
    const client = yield* relayClient(session.relayUrl);
    const dpop = yield* proofFor({
      key: key.value,
      method: "POST",
      url: authUrls(session.relayUrl).auth.signOut(),
    });
    yield* client.auth
      .signOut({
        headers: { dpop },
        payload: { refresh_token: session.refreshToken },
      })
      .pipe(Effect.timeout("15 seconds"));
    return true;
  });

  const bestEffortSignOut = (session: PersistedRelaySession) =>
    signOutSession(session).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not end the styal Link session at the relay.", { cause }).pipe(
          Effect.as(false),
        ),
      ),
    );

  const verifyEmailSignIn = Effect.fn("cloud.cli_session.verify_email_sign_in")(
    function* (input: { readonly email: string; readonly code: string }) {
      const relayUrl = yield* configuredRelayUrl;
      const key = yield* getOrCreateKey;
      const client = yield* relayClient(relayUrl);
      const dpop = yield* proofFor({
        key,
        method: "POST",
        url: authUrls(relayUrl).auth.verifyEmailSignIn(),
      });
      const response = yield* client.auth
        .verifyEmailSignIn({
          headers: { dpop },
          payload: {
            email: input.email,
            code: input.code,
            client_id: RelayCliClientId,
            label: yield* label,
          },
        })
        .pipe(Effect.timeout("15 seconds"), Effect.mapError(relayAuthFailure));
      const previous = yield* readSession;
      const session = yield* storeSignedInSession(relayUrl, response);
      if (Option.isSome(previous) && previous.value.refreshToken !== session.refreshToken) {
        yield* bestEffortSignOut(previous.value);
      }
      return toIdentity(session);
    },
    withCredentialLock,
    semaphore.withPermits(1),
  );

  const currentIdentity = semaphore.withPermits(1)(
    activeSession.pipe(Effect.map(Option.map(({ session }) => toIdentity(session)))),
  );

  const storedIdentity = Effect.gen(function* () {
    const session = yield* readSession;
    if (Option.isNone(session)) return Option.none<CloudCliIdentity>();
    return session.value.relayUrl === (yield* configuredRelayUrl)
      ? Option.some(toIdentity(session.value))
      : Option.none<CloudCliIdentity>();
  });

  const hasCredential = Effect.gen(function* () {
    const session = yield* readSession;
    if (Option.isSome(session)) return session.value.relayUrl === (yield* configuredRelayUrl);
    if (Option.isSome(yield* readSecretString(LEGACY_CLERK_ADOPTED_SECRET))) return false;
    return Option.isSome(yield* readSecretString(LEGACY_CLERK_CLI_TOKEN_SECRET));
  });

  const authorize = Effect.fn("cloud.cli_session.authorize")(function* (
    method: string,
    url: string,
  ) {
    const requestUrl = URL.parse(url);
    if (requestUrl?.origin !== (yield* configuredRelayUrl)) {
      return Option.none<CloudCliAuthorizationHeaders>();
    }
    const active = yield* semaphore.withPermits(1)(activeSession);
    if (Option.isNone(active)) return Option.none<CloudCliAuthorizationHeaders>();
    const dpop = yield* proofFor({
      key: active.value.key,
      method,
      url,
      accessToken: active.value.accessToken,
    });
    return Option.some({
      authorization: `DPoP ${active.value.accessToken}`,
      dpop,
    } satisfies CloudCliAuthorizationHeaders);
  });

  const signOut = semaphore.withPermits(1)(
    Effect.gen(function* () {
      const session = yield* readSession;
      const revoked = Option.isSome(session) ? yield* bestEffortSignOut(session.value) : false;
      cachedAccessToken = undefined;
      cachedKey = undefined;
      yield* removeSecret(CLOUD_RELAY_SESSION_SECRET);
      yield* removeSecret(LEGACY_CLERK_CLI_TOKEN_SECRET);
      yield* removeSecret(CLOUD_CLI_DPOP_KEY_SECRET);
      yield* removeSecret(LEGACY_CLERK_ADOPTED_SECRET);
      return Option.isNone(session)
        ? ("not-signed-in" as const)
        : revoked
          ? ("revoked" as const)
          : ("revoke-failed" as const);
    }).pipe(withCredentialLock),
  );

  return CloudCliSession.of({
    startEmailSignIn,
    verifyEmailSignIn,
    currentIdentity,
    storedIdentity,
    hasCredential,
    authorize,
    signOut,
  });
});

export const layer = Layer.effect(CloudCliSession, make);

/** Failures that can clear without replacing the stored credential. */
export const canRetryCredentialRecovery = (error: CloudCliSessionError | Cause.TimeoutError) =>
  error._tag === "CloudCliRelayUnavailableError" ||
  error._tag === "TimeoutError" ||
  (error._tag === "CloudCliSessionStorageError" &&
    isSecretStoreLockError(error.cause) &&
    error.cause.reason === "busy");

/** Noninteractive migration, independent of tunnel reconciliation and local startup. */
export const layerStartupAdoption = Layer.effectDiscard(
  Effect.gen(function* () {
    const session = yield* CloudCliSession;
    yield* Effect.gen(function* () {
      if (!(yield* session.hasCredential)) return;
      if (Option.isSome(yield* session.storedIdentity)) return;
      yield* session.currentIdentity;
    }).pipe(
      Effect.timeout("45 seconds"),
      Effect.tapError((error) =>
        Effect.logWarning(
          canRetryCredentialRecovery(error)
            ? "Stored styal Link sign-in adoption will retry in the background."
            : "Stored styal Link sign-in adoption stopped; run `styal link login` to sign in again.",
          { reason: error._tag },
        ),
      ),
      Effect.retry({
        while: canRetryCredentialRecovery,
        schedule: Schedule.exponential("1 second").pipe(
          Schedule.modifyDelay(({ duration }) =>
            Effect.succeed(Duration.min(duration, Duration.minutes(5))),
          ),
        ),
      }),
      Effect.ignore,
      Effect.forkScoped,
    );
  }),
);
