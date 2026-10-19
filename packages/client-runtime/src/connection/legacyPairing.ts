import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Socket from "effect/socket/Socket";

import type { PreparedConnection } from "./model.ts";
import * as ConnectionResolver from "./resolver.ts";
import * as EnvironmentRegistry from "./registry.ts";
import { connectionRouteId, connectionRoutes, legacyPairingRouteId, routeEntry } from "./routes.ts";

const SOCKET_OPEN_TIMEOUT = "15 seconds";

/**
 * Drops the old pairing that `checked` signs in with when T3 Connect can stand
 * in for it. Dropping the pairing ends a working connection, so T3 Connect must
 * first sign in and open a socket to the environment; an expired sign-in, an
 * unreachable relay, or a network that refuses WebSocket upgrades keeps the
 * pairing. Returns whether the pairing was dropped.
 */
export const retireLegacyPairing = Effect.fn("clientRuntime.connection.retireLegacyPairing")(
  function* (environmentId: EnvironmentId, checked: PreparedConnection) {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const resolver = yield* ConnectionResolver.ConnectionResolver;
    const webSocketConstructor = yield* Socket.WebSocketConstructor;
    const entry = (yield* SubscriptionRef.get(registry.entries)).get(environmentId);
    if (entry === undefined) return false;
    if (legacyPairingRouteId(entry, connectionRouteId(checked.target)) === null) return false;
    const relay = connectionRoutes(entry).find(
      (route) => route.target._tag === "RelayConnectionTarget",
    );
    if (relay === undefined) return false;
    const reachable = yield* resolver.prepare(routeEntry(entry, relay)).pipe(
      Effect.flatMap((prepared) =>
        Socket.makeWebSocket(prepared.socketUrl, { openTimeout: SOCKET_OPEN_TIMEOUT }),
      ),
      // Acquiring the reader waits for the socket to open; the scope closes it.
      Effect.flatMap((socket) => socket.reader),
      Effect.scoped,
      Effect.provideService(Socket.WebSocketConstructor, webSocketConstructor),
      Effect.as(true),
      Effect.catch((error) =>
        Effect.logInfo("Kept an old pairing because T3 Connect could not connect.", {
          environmentId,
          error,
        }).pipe(Effect.as(false)),
      ),
    );
    if (!reachable) return false;
    return yield* registry.retireLegacyPairing(environmentId, checked);
  },
);
