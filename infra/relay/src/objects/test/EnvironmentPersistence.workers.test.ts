import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  environmentLinkContract,
  environmentCredentialContract,
  agentActivityContract,
} from "../../test/environmentPersistenceContract.ts";
import { environmentLayer } from "../EnvironmentPersistence.ts";
import type { EnvironmentBindings } from "../EnvironmentCoordinator.ts";

declare global {
  namespace Cloudflare {
    interface Env extends EnvironmentBindings {}
  }
}
const layer = Layer.effectContext(
  Effect.gen(function* () {
    yield* Effect.promise(() => reset());
    return yield* Layer.build(environmentLayer(env));
  }),
).pipe(Layer.provide(SecureRandom.layerWebCrypto));

environmentLinkContract("SQLite object environment links", layer);
environmentCredentialContract("SQLite object machine credentials", layer);
agentActivityContract("SQLite object activity", layer);
