import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { lt } from "drizzle-orm";
import * as RelayDb from "../db.ts";
import { relayDpopProofs } from "./schema.ts";
import { DpopProofReplay, DpopProofReplayPersistenceError } from "../auth/DpopProofs.ts";
import { ReplayPersistence } from "./IdentityPersistence.ts";

const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const consume: DpopProofReplay["Service"]["consume"] = Effect.fn("relay.dpop_proofs.consume")(
    function* (input) {
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      const inserted = yield* db
        .insert(relayDpopProofs)
        .values({
          thumbprint: input.thumbprint,
          jti: input.jti,
          iat: input.iat,
          expiresAt: DateTime.formatIso(input.expiresAt),
          createdAt,
        })
        .onConflictDoNothing()
        .returning({ jti: relayDpopProofs.jti })
        .pipe(
          Effect.mapError(
            (cause) =>
              new DpopProofReplayPersistenceError({
                operation: "consume",
                thumbprint: input.thumbprint,
                jti: input.jti,
                iat: input.iat,
                cause,
              }),
          ),
        );
      return inserted.length > 0;
    },
  );

  const pruneExpired: DpopProofReplay["Service"]["pruneExpired"] = Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* Effect.annotateCurrentSpan({ "relay.dpop_prune.before": now });
    yield* db
      .delete(relayDpopProofs)
      .where(lt(relayDpopProofs.expiresAt, now))
      .pipe(
        Effect.mapError(
          (cause) =>
            new DpopProofReplayPersistenceError({
              operation: "prune-expired",
              expiresBefore: now,
              cause,
            }),
        ),
      );
  }).pipe(Effect.withSpan("relay.dpop_proofs.prune_expired"));

  return ReplayPersistence.of({ consume, pruneExpired });
});
export const layer = Layer.effect(ReplayPersistence, make);
