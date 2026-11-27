import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { DpopProofReplayPersistenceError } from "../auth/DpopProofs.ts";
import { ReplayPersistence } from "../persistence/IdentityPersistence.ts";
import type { ReplayObject } from "./ReplayObject.ts";
import type { InventoryObject } from "./InventoryObject.ts";
import { inventoryShardName, inventoryShardNames, replayName } from "./names.ts";
import { RPC_VERSION as version } from "./storage.ts";

export interface ReplayBindings {
  REPLAYS: Pick<DurableObjectNamespace<ReplayObject>, "getByName">;
  INVENTORY: Pick<DurableObjectNamespace<InventoryObject>, "getByName">;
}

export const replayLayer = (bindings: ReplayBindings) =>
  Layer.succeed(
    ReplayPersistence,
    ReplayPersistence.of({
      consume: Effect.fn("relay.object_replay.consume")(function* (input) {
        const name = replayName(input.thumbprint, input.jti);
        const request = {
          version,
          thumbprint: input.thumbprint,
          jti: input.jti,
          iat: input.iat,
          expiresAt: DateTime.formatIso(input.expiresAt),
          createdAt: DateTime.formatIso(yield* DateTime.now),
        };
        return yield* Effect.tryPromise({
          try: async () => {
            const stub = bindings.REPLAYS.getByName(name);
            const first = await stub.consume(request);
            if (!("needsRegistration" in first)) return first.consumed;
            await bindings.INVENTORY.getByName(inventoryShardName("replay", name)).register({
              version,
              references: [{ kind: "replay", name }],
            });
            const written = await stub.consume({ ...request, registered: true });
            if (!("consumed" in written)) throw new Error("Replay inventory publication failed");
            return written.consumed;
          },
          catch: (cause) =>
            new DpopProofReplayPersistenceError({
              operation: "consume",
              thumbprint: input.thumbprint,
              jti: input.jti,
              iat: input.iat,
              cause,
            }),
        });
      }),
      pruneExpired: Effect.gen(function* () {
        const expiresBefore = DateTime.formatIso(yield* DateTime.now);
        yield* Effect.tryPromise({
          try: async () => {
            // Legacy maintenance only; proof consumption never discovers objects through inventory.
            for (const shard of inventoryShardNames) {
              let after = "";
              for (;;) {
                const refs = await bindings.INVENTORY.getByName(shard).list({
                  version,
                  kind: "replay",
                  after,
                  limit: 1000,
                });
                for (const ref of refs)
                  await bindings.REPLAYS.getByName(ref.name).prune({ version, expiresBefore });
                if (refs.length < 1000) break;
                after = refs[refs.length - 1]!.name;
              }
            }
          },
          catch: (cause) =>
            new DpopProofReplayPersistenceError({
              operation: "prune-expired",
              expiresBefore,
              cause,
            }),
        });
      }).pipe(Effect.withSpan("relay.object_replay.prune_expired")),
    }),
  );
