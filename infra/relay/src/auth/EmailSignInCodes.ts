import { and, asc, desc, eq, gt, gte, isNull, lt, lte, sql } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as RelayConfiguration from "../Config.ts";
import * as RelayDb from "../db.ts";
import { persistenceCause } from "./persistenceCause.ts";
import { relayEmailSignInCodes } from "../persistence/schema.ts";

export const SIGN_IN_CODE_TTL_MINUTES = 10;
/** Guesses allowed per code, counting the correct one. */
export const SIGN_IN_CODE_MAX_ATTEMPTS = 5;
/** Codes one device key can request for an address per rolling hour. */
export const SIGN_IN_CODES_PER_KEY_PER_HOUR = 5;
/**
 * Codes an address can be sent per rolling hour across all keys. Higher than
 * the per-key cap to leave room for multiple devices while bounding how much
 * mail one address receives. Together with five attempts per eight-digit code,
 * this bounds guessing to 100 attempts per hour against 100 million codes.
 */
export const SIGN_IN_CODES_PER_EMAIL_PER_HOUR = 20;
export const SIGN_IN_CODE_RESEND_AFTER_SECONDS = 30;

export class SignInCodePersistenceError extends Schema.TaggedError<SignInCodePersistenceError>()(
  "SignInCodePersistenceError",
  {
    operation: Schema.Literals(["issue", "redeem", "discard", "prune-expired"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Relay sign-in code '${this.operation}' failed`;
  }
}

export class SignInCodeRateLimited extends Schema.TaggedError<SignInCodeRateLimited>()(
  "SignInCodeRateLimited",
  { retryAfterSeconds: Schema.Int },
) {
  override get message(): string {
    return `Too many sign-in codes requested; retry in ${this.retryAfterSeconds} seconds`;
  }
}

export type RedeemResult = "redeemed" | "incorrect" | "expired" | "too_many_attempts";

export interface IssuedCode {
  readonly codeId: string;
  readonly code: string;
  readonly expiresAt: DateTime.Utc;
}

export class EmailSignInCodes extends Context.Service<
  EmailSignInCodes,
  {
    /**
     * Stores a new code for the email and proof key. `fixedCode` replaces the
     * random code for test accounts on non-production stages.
     */
    readonly issue: (input: {
      readonly email: string;
      readonly thumbprint: string;
      readonly fixedCode?: string;
    }) => Effect.Effect<IssuedCode, SignInCodeRateLimited | SignInCodePersistenceError>;
    /** Checks the newest live code for the email and key. Each call uses one attempt. */
    readonly redeem: (input: {
      readonly email: string;
      readonly thumbprint: string;
      readonly code: string;
    }) => Effect.Effect<RedeemResult, SignInCodePersistenceError>;
    /** Removes a code whose email could not be sent, so it does not count against the hourly cap. */
    readonly discard: (codeId: string) => Effect.Effect<void, SignInCodePersistenceError>;
    readonly pruneExpired: Effect.Effect<void, SignInCodePersistenceError>;
  }
>()("t3code-relay/auth/EmailSignInCodes") {}

/** Eight digits, uniform over 00000000-99999999. */
export const generateSignInCode = (crypto: Crypto.Crypto) =>
  crypto
    .randomIntBetween(0, 100_000_000, { halfOpen: true })
    .pipe(Effect.map((value) => value.toString().padStart(8, "0")));

/** Seconds until the oldest code in the window leaves it, freeing a slot. */
export function retryAfterSeconds(oldestCreatedAt: DateTime.Utc, now: DateTime.Utc): number {
  const freedAt = DateTime.add(oldestCreatedAt, { hours: 1 });
  return Math.max(1, Math.ceil((freedAt.epochMilliseconds - now.epochMilliseconds) / 1_000));
}

const constantTimeEqual = (left: string, right: string): boolean => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
};

const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const crypto = yield* Crypto.Crypto;
  const config = yield* RelayConfiguration.RelayConfiguration;

  // Keyed with a deployment secret, so a database read alone cannot recover
  // codes by hashing all 100 million candidates.
  const hashCode = (codeId: string, code: string) =>
    crypto
      .digest(
        "SHA-256",
        new TextEncoder().encode(`${Redacted.value(config.signInCodeSecret)}:${codeId}:${code}`),
      )
      .pipe(Effect.map(Base64Url.encode));

  const issue: EmailSignInCodes["Service"]["issue"] = Effect.fn("relay.sign_in_codes.issue")(
    function* (input) {
      const now = yield* DateTime.now;
      const windowStart = DateTime.formatIso(DateTime.subtract(now, { hours: 1 }));
      const codeId = (yield* crypto.randomUUIDv4).replaceAll("-", "");
      const code = input.fixedCode ?? (yield* generateSignInCode(crypto));
      const codeHash = yield* hashCode(codeId, code);
      const expiresAt = DateTime.add(now, { minutes: SIGN_IN_CODE_TTL_MINUTES });
      // The address lock makes the caps hold under concurrent requests.
      yield* db.$client.withTransaction(
        Effect.gen(function* () {
          yield* db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${input.email}))`);
          const recent = yield* db
            .select({
              createdAt: relayEmailSignInCodes.createdAt,
              thumbprint: relayEmailSignInCodes.thumbprint,
            })
            .from(relayEmailSignInCodes)
            .where(
              and(
                eq(relayEmailSignInCodes.email, input.email),
                gte(relayEmailSignInCodes.createdAt, windowStart),
              ),
            )
            .orderBy(asc(relayEmailSignInCodes.createdAt));
          const forKey = recent.filter((row) => row.thumbprint === input.thumbprint);
          const limitedBy =
            forKey.length >= SIGN_IN_CODES_PER_KEY_PER_HOUR
              ? forKey
              : recent.length >= SIGN_IN_CODES_PER_EMAIL_PER_HOUR
                ? recent
                : null;
          const oldest = limitedBy?.[0];
          if (oldest) {
            return yield* new SignInCodeRateLimited({
              retryAfterSeconds: retryAfterSeconds(DateTime.makeUnsafe(oldest.createdAt), now),
            });
          }
          yield* db.insert(relayEmailSignInCodes).values({
            codeId,
            email: input.email,
            thumbprint: input.thumbprint,
            codeHash,
            attempts: 0,
            consumedAt: null,
            expiresAt: DateTime.formatIso(expiresAt),
            createdAt: DateTime.formatIso(now),
          });
        }),
      );
      return { codeId, code, expiresAt };
    },
    Effect.mapError((cause) =>
      cause._tag === "SignInCodeRateLimited"
        ? cause
        : new SignInCodePersistenceError({ operation: "issue", cause: persistenceCause(cause) }),
    ),
  );

  const redeem: EmailSignInCodes["Service"]["redeem"] = Effect.fn("relay.sign_in_codes.redeem")(
    function* (input) {
      const now = DateTime.formatIso(yield* DateTime.now);
      // Requesting a new code makes older ones useless.
      const latest = yield* db
        .select({ codeId: relayEmailSignInCodes.codeId })
        .from(relayEmailSignInCodes)
        .where(
          and(
            eq(relayEmailSignInCodes.email, input.email),
            eq(relayEmailSignInCodes.thumbprint, input.thumbprint),
          ),
        )
        .orderBy(desc(relayEmailSignInCodes.createdAt))
        .limit(1);
      const codeId = latest[0]?.codeId;
      if (!codeId) {
        return "expired" as const;
      }
      // Spends an attempt and reads the hash in one statement, so concurrent
      // guesses cannot exceed the cap.
      const attempted = yield* db
        .update(relayEmailSignInCodes)
        .set({ attempts: sql`${relayEmailSignInCodes.attempts} + 1` })
        .where(
          and(
            eq(relayEmailSignInCodes.codeId, codeId),
            isNull(relayEmailSignInCodes.consumedAt),
            gt(relayEmailSignInCodes.expiresAt, now),
            lt(relayEmailSignInCodes.attempts, SIGN_IN_CODE_MAX_ATTEMPTS),
          ),
        )
        .returning({
          codeHash: relayEmailSignInCodes.codeHash,
          attempts: relayEmailSignInCodes.attempts,
        });
      const row = attempted[0];
      if (!row) {
        const current = yield* db
          .select({
            attempts: relayEmailSignInCodes.attempts,
            consumedAt: relayEmailSignInCodes.consumedAt,
            expiresAt: relayEmailSignInCodes.expiresAt,
          })
          .from(relayEmailSignInCodes)
          .where(eq(relayEmailSignInCodes.codeId, codeId))
          .limit(1);
        const state = current[0];
        return state &&
          state.consumedAt === null &&
          state.expiresAt > now &&
          state.attempts >= SIGN_IN_CODE_MAX_ATTEMPTS
          ? ("too_many_attempts" as const)
          : ("expired" as const);
      }
      if (!constantTimeEqual(row.codeHash, yield* hashCode(codeId, input.code))) {
        return row.attempts >= SIGN_IN_CODE_MAX_ATTEMPTS
          ? ("too_many_attempts" as const)
          : ("incorrect" as const);
      }
      const consumed = yield* db
        .update(relayEmailSignInCodes)
        .set({ consumedAt: now })
        .where(
          and(eq(relayEmailSignInCodes.codeId, codeId), isNull(relayEmailSignInCodes.consumedAt)),
        )
        .returning({ codeId: relayEmailSignInCodes.codeId });
      return consumed.length > 0 ? ("redeemed" as const) : ("expired" as const);
    },
    Effect.mapError(
      (cause) =>
        new SignInCodePersistenceError({ operation: "redeem", cause: persistenceCause(cause) }),
    ),
  );

  return EmailSignInCodes.of({
    issue,
    redeem,
    discard: Effect.fn("relay.sign_in_codes.discard")(
      function* (codeId) {
        yield* db.delete(relayEmailSignInCodes).where(eq(relayEmailSignInCodes.codeId, codeId));
      },
      Effect.mapError(
        (cause) =>
          new SignInCodePersistenceError({ operation: "discard", cause: persistenceCause(cause) }),
      ),
    ),
    // Kept for an hour past expiry so they still count toward the issuance caps.
    pruneExpired: Effect.gen(function* () {
      const cutoff = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { hours: 1 }));
      yield* db.delete(relayEmailSignInCodes).where(lte(relayEmailSignInCodes.expiresAt, cutoff));
    }).pipe(
      Effect.mapError(
        (cause) =>
          new SignInCodePersistenceError({
            operation: "prune-expired",
            cause: persistenceCause(cause),
          }),
      ),
      Effect.withSpan("relay.sign_in_codes.prune_expired"),
    ),
  });
});

export const layer = Layer.effect(EmailSignInCodes, make);
