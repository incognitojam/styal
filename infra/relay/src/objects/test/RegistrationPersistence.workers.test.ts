import { env } from "cloudflare:workers";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { registrationPersistenceContract } from "../../test/registrationPersistenceContract.ts";
import { deliveryTargetPersistenceContract } from "../../test/deliveryTargetPersistenceContract.ts";
import { config } from "../../test/fixtures.ts";
import * as Config from "../../Config.ts";
import { identityLayer } from "../IdentityPersistence.ts";
import { registrationLayer } from "../RegistrationPersistence.ts";
import { disabledRegistrationCleanup } from "./registrationFixtures.ts";
import { resetRegistrationObjects } from "./resetRegistrationObjects.ts";

const layer = Layer.effectContext(
  Effect.gen(function* () {
    yield* Effect.promise(resetRegistrationObjects);
    return yield* Layer.build(
      Layer.mergeAll(
        identityLayer(env, {
          emailKey: new Uint8Array(32).fill(1),
          signInCodeSecret: "synthetic-code-secret",
        }),
        registrationLayer(env),
      ),
    );
  }),
).pipe(Layer.provide(Layer.mergeAll(SecureRandom.layerWebCrypto, Config.layer(config))));

registrationPersistenceContract("SQLite object registration persistence", layer);
deliveryTargetPersistenceContract(
  "SQLite object cleanup and FCM tokens",
  layer.pipe(Layer.provide(disabledRegistrationCleanup)),
);
