import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProviderInstallLock from "./ProviderInstallLock.ts";

it.effect("skips a second installer for the same target until the first releases the lock", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const cacheHome = yield* fileSystem.makeTempDirectoryScoped({ prefix: "styal-install-lock-" });
    yield* Effect.gen(function* () {
      const lock = yield* ProviderInstallLock.ProviderInstallLock;
      const inside = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const first = yield* lock
        .tryRun("npm-global:/prefix", () =>
          Deferred.succeed(inside, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as("first"),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(inside);

      assert.isTrue(yield* lock.keyHeld("npm-global:/prefix"));
      assert.isFalse(yield* lock.keyHeld("homebrew"));
      assert.isTrue(Option.isNone(yield* lock.tryRun("npm-global:/prefix", () => Effect.void)));
      assert.deepStrictEqual(
        yield* lock.tryRun("homebrew", () => Effect.succeed("other")),
        Option.some("other"),
      );

      yield* Deferred.succeed(release, undefined);
      assert.deepStrictEqual(yield* Fiber.join(first), Option.some("first"));
      assert.isFalse(yield* lock.anyHeld);
      assert.deepStrictEqual(
        yield* lock.tryRun("npm-global:/prefix", () => Effect.succeed("next")),
        Option.some("next"),
      );
    }).pipe(
      Effect.provide(
        ProviderInstallLock.layer.pipe(
          Layer.provide(Layer.succeed(HostProcess.Environment, { XDG_CACHE_HOME: cacheHome })),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
