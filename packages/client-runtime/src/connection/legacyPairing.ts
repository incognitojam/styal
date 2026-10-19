import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { PreparedConnection } from "./model.ts";
import * as ConnectionResolver from "./resolver.ts";
import * as EnvironmentRegistry from "./registry.ts";
import { connectionRouteId, connectionRoutes, legacyPairingRouteId, routeEntry } from "./routes.ts";

/**
 * Drops the old pairing that `checked` signs in with when T3 Connect can stand
 * in for it. T3 Connect must sign in first: dropping the pairing ends a working
 * connection, so an expired T3 Connect sign-in or an unreachable relay keeps
 * the pairing. Returns whether the pairing was dropped.
 */
export const retireLegacyPairing = Effect.fn("clientRuntime.connection.retireLegacyPairing")(
  function* (environmentId: EnvironmentId, checked: PreparedConnection) {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const resolver = yield* ConnectionResolver.ConnectionResolver;
    const entry = (yield* SubscriptionRef.get(registry.entries)).get(environmentId);
    if (entry === undefined) return false;
    if (legacyPairingRouteId(entry, connectionRouteId(checked.target)) === null) return false;
    const relay = connectionRoutes(entry).find(
      (route) => route.target._tag === "RelayConnectionTarget",
    );
    if (relay === undefined) return false;
    const signedIn = yield* resolver.prepare(routeEntry(entry, relay)).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        Effect.logInfo("Kept an old pairing because T3 Connect could not sign in.", {
          environmentId,
          error,
        }).pipe(Effect.as(false)),
      ),
    );
    if (!signedIn) return false;
    return yield* registry.retireLegacyPairing(environmentId, checked);
  },
);
