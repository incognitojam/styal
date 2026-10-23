import { relayProtectedErrorMessage } from "@t3tools/client-runtime/relay";
import * as Cause from "effect/Cause";
import type * as Exit from "effect/Exit";

export const SIGN_IN_CODE_LENGTH = 8;

/** Keeps the digits of a typed or pasted code, so "1234 5678" and "1234-5678" both work. */
export function normalizeSignInCode(value: string): string {
  return value.replace(/\D/gu, "").slice(0, SIGN_IN_CODE_LENGTH);
}

export function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value.trim());
}

interface RelayFailureShape {
  readonly _tag?: string;
  readonly transportFailed?: boolean;
  readonly relayError?: Parameters<typeof relayProtectedErrorMessage>[0];
}

/** The message to show for a failed sign-in request. */
export function signInFailureMessage(exit: Exit.Failure<unknown, unknown>): string {
  const error = Cause.squash(exit.cause) as RelayFailureShape | undefined;
  if (error?.relayError) return relayProtectedErrorMessage(error.relayError);
  if (error?._tag === "ManagedRelayRequestTimeoutError" || error?.transportFailed) {
    return "Can't reach styal Link. Check your connection and try again.";
  }
  return "Something went wrong. Try again.";
}
