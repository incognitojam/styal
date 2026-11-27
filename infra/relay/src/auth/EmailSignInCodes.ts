import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { EmailPersistence } from "../persistence/IdentityPersistence.ts";

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
    readonly discard: (input: {
      readonly email: string;
      readonly codeId: string;
    }) => Effect.Effect<void, SignInCodePersistenceError>;
    readonly pruneExpired: Effect.Effect<void, SignInCodePersistenceError>;
  }
>()("t3code-relay/auth/EmailSignInCodes") {}

/** Eight digits, uniform over 00000000-99999999. */
export const generateSignInCode = (random: SecureRandom.SecureRandom["Service"]) =>
  random
    .intBetween(0, 100_000_000, { halfOpen: true })
    .pipe(Effect.map((value) => value.toString().padStart(8, "0")));

/** Seconds until the oldest code in the window leaves it, freeing a slot. */
export function retryAfterSeconds(oldestCreatedAt: DateTime.Utc, now: DateTime.Utc): number {
  const freedAt = DateTime.add(oldestCreatedAt, { hours: 1 });
  return Math.max(1, Math.ceil((freedAt.epochMilliseconds - now.epochMilliseconds) / 1_000));
}

export const layer = Layer.effect(
  EmailSignInCodes,
  Effect.map(EmailPersistence, (store) => EmailSignInCodes.of(store)),
);
