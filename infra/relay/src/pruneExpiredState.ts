import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as AgentActivityRows from "./agentActivity/AgentActivityRows.ts";
import * as AuthSessions from "./auth/AuthSessions.ts";
import * as DpopProofs from "./auth/DpopProofs.ts";
import * as EmailSignInCodes from "./auth/EmailSignInCodes.ts";

/** Logs a failed prune so the steps after it still run. */
const independently = <E, R>(label: string, effect: Effect.Effect<void, E, R>) =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.interrupt
        : Effect.logWarning(`Failed to prune ${label}`, { cause }),
    ),
  );

/**
 * The cron's database pruning. Each step runs whether or not the earlier ones
 * failed: a queue outage that fails session pruning (it queues Live Activity
 * ends) must not stop activity rows from being pruned.
 */
export const pruneExpiredState = Effect.gen(function* () {
  yield* independently(
    "DPoP proofs",
    DpopProofs.DpopProofReplay.pipe(Effect.flatMap((proofs) => proofs.pruneExpired)),
  );
  yield* independently(
    "sign-in codes",
    EmailSignInCodes.EmailSignInCodes.pipe(Effect.flatMap((codes) => codes.pruneExpired)),
  );
  yield* independently(
    "auth sessions",
    AuthSessions.AuthSessions.pipe(Effect.flatMap((sessions) => sessions.pruneExpired)),
  );
  // Keep completed thread rows long enough to show their final state.
  yield* independently(
    "agent activity rows",
    Effect.all([AgentActivityRows.AgentActivityRows, DateTime.now]).pipe(
      Effect.flatMap(([activityRows, now]) =>
        activityRows.pruneTerminal({
          updatedBefore: DateTime.formatIso(DateTime.subtract(now, { minutes: 30 })),
        }),
      ),
    ),
  );
});
