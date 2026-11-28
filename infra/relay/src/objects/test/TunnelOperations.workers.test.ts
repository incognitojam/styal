import { reset } from "cloudflare:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TunnelOperationPersistence } from "../../persistence/TunnelOperationPersistence.ts";
import { env } from "cloudflare:workers";
import { tunnelOperationContract } from "../../test/tunnelOperationContract.ts";
import { tunnelOperationsLayer, type ObjectBindings } from "../TunnelOperations.ts";

declare global {
  namespace Cloudflare {
    interface Env extends ObjectBindings {}
  }
}

tunnelOperationContract(
  "SQLite object tunnel operations",
  Layer.effect(
    TunnelOperationPersistence,
    Effect.gen(function* () {
      // The integration isolates files; the shared contract needs a fresh store per layer.
      yield* Effect.promise(() => reset());
      return yield* TunnelOperationPersistence.pipe(Effect.provide(tunnelOperationsLayer(env)));
    }),
  ),
);
