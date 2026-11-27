import { and, asc, desc, eq, gt, gte, isNull, lt, lte, sql } from "drizzle-orm";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as RelayConfiguration from "../Config.ts";
import * as RelayDb from "../db.ts";
import { persistenceCause } from "../auth/persistenceCause.ts";
import { relayEmailSignInCodes } from "./schema.ts";
import {
  EmailSignInCodes,
  SignInCodePersistenceError,
  SignInCodeRateLimited,
  SIGN_IN_CODE_TTL_MINUTES,
  SIGN_IN_CODE_MAX_ATTEMPTS,
  SIGN_IN_CODES_PER_KEY_PER_HOUR,
  SIGN_IN_CODES_PER_EMAIL_PER_HOUR,
  generateSignInCode,
  retryAfterSeconds,
} from "../auth/EmailSignInCodes.ts";
import { EmailPersistence } from "./IdentityPersistence.ts";

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
  const digest = yield* Digest.Digest;
  const random = yield* SecureRandom.SecureRandom;
  const config = yield* RelayConfiguration.RelayConfiguration;

  // Keyed with a deployment secret, so a database read alone cannot recover
  // codes by hashing all 100 million candidates.
  const hashCode = (codeId: string, code: string) =>
    digest
      .digest(
        Digest.sha256,
        new TextEncoder().encode(`${Redacted.value(config.signInCodeSecret)}:${codeId}:${code}`),
      )
      .pipe(Effect.map(Base64Url.encode));

  const issue: EmailSignInCodes["Service"]["issue"] = Effect.fn("relay.sign_in_codes.issue")(
    function* (input) {
      const now = yield* DateTime.now;
      const windowStart = DateTime.formatIso(DateTime.subtract(now, { hours: 1 }));
      const codeId = (yield* random.uuidV4()).replaceAll("-", "");
      const code = input.fixedCode ?? (yield* generateSignInCode(random));
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

  return EmailPersistence.of({
    issue,
    redeem,
    discard: Effect.fn("relay.sign_in_codes.discard")(
      function* ({ codeId }) {
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

export const layer = Layer.effect(EmailPersistence, make);
