import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ReplayPersistence } from "../../persistence/IdentityPersistence.ts";
import { identityPersistenceContract } from "../../test/identityPersistenceContract.ts";
import { identityLayer } from "../IdentityPersistence.ts";
import type { IdentityBindings } from "../IdentityCoordinator.ts";

declare global {
  namespace Cloudflare {
    interface Env extends IdentityBindings {}
  }
}

// Replay belongs to piece 6; this fixture only supplies the unchanged contract's fourth port.
const replayFixture = Layer.sync(ReplayPersistence, () => {
  const entries = new Map<string, number>();
  return ReplayPersistence.of({
    consume: (input) =>
      Effect.sync(() => {
        const key = JSON.stringify([input.thumbprint, input.jti]);
        if (entries.has(key)) return false;
        entries.set(key, input.expiresAt.epochMilliseconds);
        return true;
      }),
    pruneExpired: Effect.gen(function* () {
      const now = yield* DateTime.now;
      for (const [key, expiresAt] of entries)
        if (expiresAt < now.epochMilliseconds) entries.delete(key);
    }),
  });
});
const layer = Layer.effectContext(
  Effect.gen(function* () {
    yield* Effect.promise(() => reset());
    return yield* Layer.build(
      Layer.mergeAll(
        identityLayer(env, {
          emailKey: new Uint8Array(32).fill(1),
          signInCodeSecret: "synthetic-code-secret",
        }),
        replayFixture,
      ),
    );
  }),
).pipe(Layer.provideMerge(SecureRandom.layerWebCrypto));

identityPersistenceContract("SQLite object identity persistence (replay fixture)", layer);
