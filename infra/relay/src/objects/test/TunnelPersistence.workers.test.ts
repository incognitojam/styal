import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SecureRandom from "effect/crypto/SecureRandom";
import {
  managedEndpointAllocationContract,
  managedTunnelLimitContract,
} from "../../test/tunnelPersistenceContract.ts";
import { environmentLayer } from "../EnvironmentPersistence.ts";
import { tunnelOperationsLayer } from "../TunnelOperations.ts";
import { tunnelPersistenceLayer } from "../TunnelPersistence.ts";
import type { TunnelBindings } from "../TunnelPersistence.ts";
import { T3ChatAccounts } from "../../t3chat/T3ChatAccounts.ts";

declare global {
  namespace Cloudflare {
    interface Env extends TunnelBindings {}
  }
}
const layer = Layer.effectContext(
  Effect.gen(function* () {
    yield* Effect.promise(() => reset());
    return yield* Layer.build(
      Layer.mergeAll(
        environmentLayer(env),
        tunnelOperationsLayer(env),
        tunnelPersistenceLayer(env),
      ).pipe(
        Layer.provide(SecureRandom.layerWebCrypto),
        Layer.provide(Layer.mock(T3ChatAccounts, { available: false })),
      ),
    );
  }),
);
managedEndpointAllocationContract("SQLite object allocations", layer);
managedTunnelLimitContract("SQLite object capacity", layer);
