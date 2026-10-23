import type { RelayDpopAccessTokenScope, RelayPublicClientId } from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as RelayConfiguration from "../Config.ts";
import * as Accounts from "./Accounts.ts";
import * as AuthSessions from "./AuthSessions.ts";
import * as ClerkDirectory from "./ClerkDirectory.ts";
import * as EmailSender from "./EmailSender.ts";
import * as EmailSignInCodes from "./EmailSignInCodes.ts";
import * as RelayTokens from "./RelayTokens.ts";

/**
 * Addresses that accept the stage's fixed test code, so agents can sign in on
 * non-production relays without a mailbox.
 */
const TEST_ACCOUNT_EMAIL = /^agent\+[^@\s]+@styal\.build$/;

export class SignInUnavailable extends Schema.TaggedError<SignInUnavailable>()(
  "SignInUnavailable",
  { reason: Schema.Literals(["not_configured", "delivery_failed"]) },
) {
  override get message(): string {
    return `Email sign-in is unavailable: ${this.reason}`;
  }
}

export class SignInRateLimited extends Schema.TaggedError<SignInRateLimited>()(
  "SignInRateLimited",
  { retryAfterSeconds: Schema.Int },
) {
  override get message(): string {
    return `Too many sign-in attempts; retry in ${this.retryAfterSeconds} seconds`;
  }
}

export class SignInCodeRejected extends Schema.TaggedError<SignInCodeRejected>()(
  "SignInCodeRejected",
  { reason: Schema.Literals(["incorrect", "expired", "too_many_attempts"]) },
) {
  override get message(): string {
    return `Sign-in code rejected: ${this.reason}`;
  }
}

export class AuthSessionInvalid extends Schema.TaggedError<AuthSessionInvalid>()(
  "AuthSessionInvalid",
  {},
) {
  override get message(): string {
    return "Relay session is unknown, expired, or bound to another key";
  }
}

/**
 * The identity provider could not be asked for the account's email. The
 * exchange fails rather than opening a session without one, so the client
 * keeps its old sign-in and tries again.
 */
export class VerifiedEmailLookupFailed extends Schema.TaggedError<VerifiedEmailLookupFailed>()(
  "VerifiedEmailLookupFailed",
  {},
) {
  override get message(): string {
    return "Could not look up the account's email";
  }
}

export class AccessTokenIssueFailed extends Schema.TaggedError<AccessTokenIssueFailed>()(
  "AccessTokenIssueFailed",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Relay access token could not be issued";
  }
}

/**
 * Per-IP limits from the Workers rate-limit bindings. Address-level limits
 * live in Postgres (see EmailSignInCodes) because bindings only count over 10
 * or 60 seconds.
 */
export class SignInRateLimiter extends Context.Service<
  SignInRateLimiter,
  {
    readonly allowStart: (key: string) => Effect.Effect<boolean>;
    readonly allowVerify: (key: string) => Effect.Effect<boolean>;
  }
>()("t3code-relay/auth/AccountAuth/SignInRateLimiter") {}

export const layerSignInRateLimiterUnlimited = Layer.succeed(SignInRateLimiter, {
  allowStart: () => Effect.succeed(true),
  allowVerify: () => Effect.succeed(true),
});

/** Seconds a client waits after a binding limit trips; the bindings count per minute. */
const BINDING_RETRY_AFTER_SECONDS = 60;

export interface AccessGrant {
  readonly accessToken: string;
  readonly expiresInSeconds: number;
  readonly scopes: ReadonlyArray<RelayDpopAccessTokenScope>;
  readonly user: { readonly id: string; readonly email: string | null };
}

export interface SessionGrant extends AccessGrant {
  readonly sessionId: string;
  readonly refreshToken: string;
}

type PersistenceError =
  | Accounts.AccountPersistenceError
  | AuthSessions.AuthSessionPersistenceError
  | EmailSignInCodes.SignInCodePersistenceError;

export class AccountAuth extends Context.Service<
  AccountAuth,
  {
    readonly startEmailSignIn: (input: {
      readonly email: string;
      readonly thumbprint: string;
      readonly rateLimitKey: string;
    }) => Effect.Effect<
      { readonly expiresAt: DateTime.Utc; readonly resendAfterSeconds: number },
      SignInUnavailable | SignInRateLimited | PersistenceError
    >;
    readonly verifyEmailSignIn: (input: {
      readonly email: string;
      readonly code: string;
      readonly clientId: RelayPublicClientId;
      readonly thumbprint: string;
      readonly label?: string;
      readonly rateLimitKey: string;
    }) => Effect.Effect<
      SessionGrant,
      | SignInCodeRejected
      | SignInRateLimited
      | VerifiedEmailLookupFailed
      | AccessTokenIssueFailed
      | PersistenceError
    >;
    /**
     * Opens a session for an account already proven by another identity
     * provider (a Clerk token during the migration away from Clerk).
     */
    readonly openVerifiedSession: (input: {
      readonly userId: string;
      /** Always refreshes the mapping from the identity provider before opening a session. */
      readonly lookupEmail: Effect.Effect<Option.Option<string>, VerifiedEmailLookupFailed>;
      readonly clientId: RelayPublicClientId;
      readonly thumbprint: string;
      readonly label?: string;
    }) => Effect.Effect<
      SessionGrant,
      VerifiedEmailLookupFailed | AccessTokenIssueFailed | PersistenceError
    >;
    readonly refresh: (input: {
      readonly refreshToken: string;
      readonly thumbprint: string;
    }) => Effect.Effect<
      AccessGrant,
      AuthSessionInvalid | AccessTokenIssueFailed | PersistenceError
    >;
    readonly signOut: (input: {
      readonly refreshToken: string;
      readonly thumbprint: string;
    }) => Effect.Effect<void, PersistenceError>;
  }
>()("t3code-relay/auth/AccountAuth") {}

const make = Effect.gen(function* () {
  const config = yield* RelayConfiguration.RelayConfiguration;
  const crypto = yield* Crypto.Crypto;
  const accounts = yield* Accounts.Accounts;
  const directory = yield* ClerkDirectory.ClerkDirectory;
  const sessions = yield* AuthSessions.AuthSessions;
  const codes = yield* EmailSignInCodes.EmailSignInCodes;
  const sender = yield* EmailSender.EmailSender;
  const relayTokens = yield* RelayTokens.RelayTokens;
  const rateLimiter = yield* SignInRateLimiter;

  const issueAccess = Effect.fnUntraced(function* (input: {
    readonly sessionId: string;
    readonly userId: string;
    readonly email: string | null;
    readonly clientId: RelayPublicClientId;
    readonly thumbprint: string;
  }) {
    const now = yield* DateTime.now;
    const scopes = RelayTokens.scopesForClient(input.clientId);
    const accessToken = yield* Effect.gen(function* () {
      return yield* relayTokens.issueDpopAccessToken({
        userId: input.userId,
        proofKeyThumbprint: input.thumbprint,
        jti: yield* crypto.randomUUIDv4,
        issuedAtEpochSeconds: Math.floor(now.epochMilliseconds / 1_000),
        expiresAtEpochSeconds: Math.floor(
          DateTime.addDuration(now, RelayTokens.RELAY_DPOP_ACCESS_TOKEN_TTL).epochMilliseconds /
            1_000,
        ),
        clientId: input.clientId,
        scopes,
        sessionId: input.sessionId,
      });
    }).pipe(Effect.mapError((cause) => new AccessTokenIssueFailed({ cause })));
    return {
      accessToken,
      expiresInSeconds: Duration.toSeconds(RelayTokens.RELAY_DPOP_ACCESS_TOKEN_TTL),
      scopes,
      user: { id: input.userId, email: input.email },
    } satisfies AccessGrant;
  });

  const openSession = Effect.fnUntraced(function* (input: {
    readonly userId: string;
    readonly email: string | null;
    readonly clientId: RelayPublicClientId;
    readonly thumbprint: string;
    readonly label?: string;
  }) {
    const session = yield* sessions.create({
      userId: input.userId,
      clientId: input.clientId,
      thumbprint: input.thumbprint,
      ...(input.label ? { label: input.label } : {}),
    });
    const access = yield* issueAccess({ ...input, sessionId: session.sessionId });
    return {
      ...access,
      sessionId: session.sessionId,
      refreshToken: session.token,
    } satisfies SessionGrant;
  });

  return AccountAuth.of({
    startEmailSignIn: Effect.fn("relay.account_auth.start_email_sign_in")(function* (input) {
      if (!sender.enabled) {
        return yield* new SignInUnavailable({ reason: "not_configured" });
      }
      if (!(yield* rateLimiter.allowStart(input.rateLimitKey))) {
        return yield* new SignInRateLimited({ retryAfterSeconds: BINDING_RETRY_AFTER_SECONDS });
      }
      const email = Accounts.normalizeEmail(input.email);
      const fixedCode =
        config.testSignInCode !== undefined && TEST_ACCOUNT_EMAIL.test(email)
          ? config.testSignInCode
          : undefined;
      const issued = yield* codes
        .issue({ email, thumbprint: input.thumbprint, ...(fixedCode ? { fixedCode } : {}) })
        .pipe(
          Effect.catchTags({
            SignInCodeRateLimited: (limited) =>
              Effect.fail(new SignInRateLimited({ retryAfterSeconds: limited.retryAfterSeconds })),
          }),
        );
      yield* sender.send({ to: email, ...EmailSender.renderSignInEmail(issued.code) }).pipe(
        Effect.catchTags({
          EmailSendFailed: (failure) =>
            Effect.annotateCurrentSpan({ "relay.auth.email_send_failure": failure.detail }).pipe(
              Effect.andThen(codes.discard(issued.codeId)),
              Effect.andThen(Effect.fail(new SignInUnavailable({ reason: "delivery_failed" }))),
            ),
        }),
      );
      return {
        expiresAt: issued.expiresAt,
        resendAfterSeconds: EmailSignInCodes.SIGN_IN_CODE_RESEND_AFTER_SECONDS,
      };
    }),

    verifyEmailSignIn: Effect.fn("relay.account_auth.verify_email_sign_in")(function* (input) {
      if (!(yield* rateLimiter.allowVerify(input.rateLimitKey))) {
        return yield* new SignInRateLimited({ retryAfterSeconds: BINDING_RETRY_AFTER_SECONDS });
      }
      const email = Accounts.normalizeEmail(input.email);
      const result = yield* codes.redeem({ email, thumbprint: input.thumbprint, code: input.code });
      if (result !== "redeemed") {
        return yield* new SignInCodeRejected({ reason: result });
      }
      // Redeem before consulting the directory so an unproven mailbox cannot
      // change account mappings. A directory outage consumes this code; the
      // caller receives a retryable failure and must request another code.
      // Without Clerk configured, the stored mapping is the only record of an
      // imported account's email, so it is kept as is.
      let account = yield* accounts.getByEmail(email);
      if (
        directory.configured &&
        Option.isSome(account) &&
        account.value.userId.startsWith("user_")
      ) {
        const verified = yield* directory
          .verifiedEmails(account.value.userId)
          .pipe(Effect.mapError(() => new VerifiedEmailLookupFailed({})));
        if (Option.isNone(verified) || !verified.value.all.includes(email)) {
          // A nullable mapping preserves the account and its history even if
          // Clerk has no verified primary or another account owns that primary.
          yield* accounts.syncEmail(
            account.value.userId,
            Option.isSome(verified) ? verified.value.primary : null,
          );
          account = yield* accounts.getByEmail(email);
        }
      }
      if (Option.isNone(account)) {
        const clerkUser = directory.configured
          ? yield* directory
              .userIdForEmail(email)
              .pipe(Effect.mapError(() => new VerifiedEmailLookupFailed({})))
          : Option.none<string>();
        account = Option.some(
          Option.isSome(clerkUser)
            ? yield* accounts.syncEmail(clerkUser.value, email)
            : yield* accounts.findOrCreateByEmail(email),
        );
      }
      const resolved = Option.getOrThrow(account);
      return yield* openSession({
        userId: resolved.userId,
        email: resolved.email,
        clientId: input.clientId,
        thumbprint: input.thumbprint,
        ...(input.label ? { label: input.label } : {}),
      });
    }),

    openVerifiedSession: Effect.fn("relay.account_auth.open_verified_session")(function* (input) {
      const email = yield* input.lookupEmail;
      const account = yield* accounts.syncEmail(input.userId, Option.getOrNull(email));
      if (Option.isSome(email) && account.email === null) {
        yield* Effect.annotateCurrentSpan({ "relay.auth.imported_email_conflict": true });
        yield* Effect.logWarning("Verified account's email belongs to another account", {
          userId: input.userId,
        });
      }
      return yield* openSession({
        userId: input.userId,
        email: account.email,
        clientId: input.clientId,
        thumbprint: input.thumbprint,
        ...(input.label ? { label: input.label } : {}),
      });
    }),

    refresh: Effect.fn("relay.account_auth.refresh")(function* (input) {
      const session = yield* sessions.authenticate({
        token: input.refreshToken,
        thumbprint: input.thumbprint,
      });
      if (Option.isNone(session)) {
        return yield* new AuthSessionInvalid({});
      }
      const account = yield* accounts.get(session.value.userId);
      return yield* issueAccess({
        sessionId: session.value.sessionId,
        userId: session.value.userId,
        email: Option.isSome(account) ? account.value.email : null,
        clientId: session.value.clientId,
        thumbprint: input.thumbprint,
      });
    }),

    signOut: Effect.fn("relay.account_auth.sign_out")(function* (input) {
      yield* sessions.revokeByToken({ token: input.refreshToken, thumbprint: input.thumbprint });
    }),
  });
});

export const layer = Layer.effect(AccountAuth, make);
