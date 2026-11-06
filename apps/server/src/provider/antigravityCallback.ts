import { ProviderSetupError, type ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { forwardLoopbackCallback } from "@t3tools/provider-core/server/loopbackCallback";

export interface AntigravityPendingCallback {
  readonly redirectUri: string;
  readonly state: string;
}

export const validateAntigravityCallbackUrl = Effect.fn("validateAntigravityCallbackUrl")(
  function* (
    instanceId: ProviderInstanceId,
    pending: AntigravityPendingCallback,
    callbackUrl: string,
  ) {
    const invalid = (detail: string) =>
      new ProviderSetupError({ instanceId, operation: "complete", detail });
    if (callbackUrl.length > 16_384) {
      return yield* invalid("The sign-in response URL is too long.");
    }
    const callback = yield* Effect.try({
      try: () => new URL(callbackUrl),
      catch: () => invalid("Paste the complete redirect URL from the Google sign-in page."),
    });
    const expected = new URL(pending.redirectUri);
    if (
      callback.protocol !== "http:" ||
      callback.hostname !== "127.0.0.1" ||
      callback.origin !== expected.origin ||
      callback.pathname !== expected.pathname ||
      callback.username !== "" ||
      callback.password !== "" ||
      callback.hash !== ""
    ) {
      return yield* invalid("This redirect URL does not belong to the current sign-in.");
    }
    const states = callback.searchParams.getAll("state");
    if (states.length !== 1 || states[0] !== pending.state) {
      return yield* invalid("This redirect URL does not belong to the current sign-in.");
    }
    const codes = callback.searchParams.getAll("code");
    const errors = callback.searchParams.getAll("error");
    if (
      !(
        (codes.length === 1 && Boolean(codes[0]) && errors.length === 0) ||
        (errors.length === 1 && Boolean(errors[0]) && codes.length === 0)
      )
    ) {
      return yield* invalid("The redirect URL must contain one Google sign-in response.");
    }
    const issuers = callback.searchParams.getAll("iss");
    if (
      issuers.length > 1 ||
      (issuers.length === 1 && issuers[0] !== "https://accounts.google.com")
    ) {
      return yield* invalid("The redirect URL is not a Google sign-in response.");
    }
    return callback;
  },
);

export const forwardAntigravityCallback = forwardLoopbackCallback;
