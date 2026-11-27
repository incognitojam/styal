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
            let result = await bindings.REPLAYS.getByName(name).consume(request);
            for (let handshake = 0; "needsRegistration" in result && handshake < 2; handshake++) {
              await bindings.INVENTORY.getByName(inventoryShardName("replay", name)).register({
                version,
                references: [{ kind: "replay", name }],
              });
              result = await bindings.REPLAYS.getByName(name).consume({
                ...request,
                initialization: result.initialization,
              });
            }
            if ("consumed" in result) return result.consumed;
            throw new DpopProofReplayPersistenceError({
              operation: "consume",
              thumbprint: input.thumbprint,
              jti: input.jti,
              iat: input.iat,
              cause: "Replay initialization repeatedly changed",
            });
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
                const inventory = () => bindings.INVENTORY.getByName(shard);
                const refs = await inventory().replayReferences({ version, after, limit: 1000 });
                for (const ref of refs) {
                  const replay = () => bindings.REPLAYS.getByName(ref.name);
                  if (!(await replay().prune({ version, expiresBefore }))) {
                    if (ref.retiring)
                      await inventory().register({
                        version,
                        references: [{ kind: "replay", name: ref.name }],
                      });
                    continue;
                  }
                  if (
                    !(await inventory().unregister({ version, name: ref.name, epoch: ref.epoch }))
                  )
                    continue;
                  if (await replay().retire({ version }))
                    await inventory().finishReplayRetirement({
                      version,
                      name: ref.name,
                      epoch: ref.epoch,
                    });
                  else
                    await inventory().register({
                      version,
                      references: [{ kind: "replay", name: ref.name }],
                    });
                }
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
