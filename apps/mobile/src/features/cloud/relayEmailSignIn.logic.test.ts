import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { RelaySignInCodeInvalidError } from "@t3tools/contracts/relay";
import * as Exit from "effect/Exit";
import { describe, expect, it } from "vite-plus/test";

import { looksLikeEmail, normalizeSignInCode, relayFailureMessage } from "./relayEmailSignIn.logic";

const failure = (error: unknown) => Exit.fail(error) as Exit.Failure<unknown, unknown>;

describe("email sign-in", () => {
  it("keeps only the digits of a pasted code", () => {
    expect(normalizeSignInCode("1234 5678")).toBe("12345678");
    expect(normalizeSignInCode("Your code: 9876-5432-1")).toBe("98765432");
  });

  it("checks email shape before sending a code", () => {
    expect(looksLikeEmail(" someone@example.com ")).toBe(true);
    expect(looksLikeEmail("someone")).toBe(false);
  });

  it("explains a wrong code, and a network failure, in plain language", () => {
    const wrongCode = new ManagedRelay.ManagedRelayRequestFailedError({
      action: "verify styal Link sign-in code",
      cause: "rejected",
      relayError: new RelaySignInCodeInvalidError({
        code: "sign_in_code_invalid",
        reason: "incorrect",
        traceId: "trace",
      }),
    });
    expect(relayFailureMessage(failure(wrongCode))).toBe(
      "That code is not right. Check the email and try again.",
    );

    const offline = new ManagedRelay.ManagedRelayRequestFailedError({
      action: "send styal Link sign-in code",
      transportFailed: true,
      cause: "offline",
    });
    expect(relayFailureMessage(failure(offline))).toBe(
      "Can't reach styal Link. Check your connection and try again.",
    );
  });
});
