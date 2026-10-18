import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as AgentActivityRows from "./agentActivity/AgentActivityRows.ts";
import * as AuthSessions from "./auth/AuthSessions.ts";
import * as DpopProofs from "./auth/DpopProofs.ts";
import * as EmailSignInCodes from "./auth/EmailSignInCodes.ts";
import { pruneExpiredState } from "./pruneExpiredState.ts";

describe("pruneExpiredState", () => {
  it.effect("prunes activity rows even when session pruning fails", () => {
    const pruned: Array<string> = [];
    const record = (name: string) =>
      Effect.sync(() => {
        pruned.push(name);
      });
    return pruneExpiredState.pipe(
      Effect.andThen(Effect.sync(() => expect(pruned).toEqual(["proofs", "codes", "activity"]))),
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(DpopProofs.DpopProofReplay, { pruneExpired: record("proofs") }),
          Layer.mock(EmailSignInCodes.EmailSignInCodes, { pruneExpired: record("codes") }),
          Layer.mock(AuthSessions.AuthSessions, {
            pruneExpired: Effect.fail(
              new AuthSessions.AuthSessionPersistenceError({
                operation: "prune-expired",
                cause: { name: "ApnsDeliveryQueueSendError" },
              }),
            ),
          }),
          Layer.mock(AgentActivityRows.AgentActivityRows, {
            pruneTerminal: () => record("activity"),
          }),
        ),
      ),
    );
  });
});
