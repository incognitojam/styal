import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { replayLayer, type ReplayBindings } from "../ReplayPersistence.ts";
import { identityPersistenceContract } from "../../test/identityPersistenceContract.ts";
import { identityLayer } from "../IdentityPersistence.ts";
import type { IdentityBindings } from "../IdentityCoordinator.ts";

declare global {
  namespace Cloudflare {
    interface Env extends IdentityBindings, ReplayBindings {}
  }
}

const layer = Layer.effectContext(
  Effect.gen(function* () {
    yield* Effect.promise(() => reset());
    return yield* Layer.build(
      Layer.mergeAll(
        identityLayer(env, {
          emailKey: new Uint8Array(32).fill(1),
          signInCodeSecret: "synthetic-code-secret",
        }),
        replayLayer(env),
      ),
    );
  }),
).pipe(Layer.provideMerge(SecureRandom.layerWebCrypto));

identityPersistenceContract("SQLite object identity persistence", layer);
