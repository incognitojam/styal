import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ProviderInstallGate from "./ProviderInstallGate.ts";
import * as ProviderInstallLock from "./ProviderInstallLock.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";

const codex = { lockKey: "npm-global:/usr/local", packageName: "@openai/codex" };
const claude = { lockKey: "npm-global:/usr/local", packageName: "@anthropic-ai/claude-code" };
const targets: Record<string, typeof codex> = { codex, claude };

const layerGate = (remoteHeld: { current: boolean }) =>
  Layer.effect(ProviderInstallGate.ProviderInstallGate, ProviderInstallGate.make).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProviderInstallLock.ProviderInstallLock)({
          tryRun: (_lockKey, run) => run(() => Effect.void).pipe(Effect.asSome),
          anyHeld: Effect.sync(() => remoteHeld.current),
          keyHeld: () => Effect.sync(() => remoteHeld.current),
        }),
        Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
          getInstance: (instanceId) =>
            Effect.succeed({
              snapshot: {
                resolveMaintenance: () =>
                  Effect.succeed({
                    provider: instanceId,
                    packageName: targets[instanceId]!.packageName,
                    update: { lockKey: targets[instanceId]!.lockKey },
                  }),
              },
            } as never),
        }),
      ),
    ),
  );

describe("ProviderInstallGate", () => {
  it.effect("holds turn starts on the CLI being installed until the install finishes", () =>
    Effect.gen(function* () {
      const gate = yield* ProviderInstallGate.ProviderInstallGate;
      const started = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const install = yield* gate
        .tryInstall(codex, () =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(finish))),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      assert.strictEqual(yield* gate.installsInFlight, 1);

      const codexTurn = yield* gate
        .awaitInstance(ProviderInstanceId.make("codex"))
        .pipe(Effect.forkChild);
      // Claude shares the npm prefix but its files are not being replaced.
      yield* gate.awaitInstance(ProviderInstanceId.make("claude"));
      yield* Effect.yieldNow;
      assert.isUndefined(codexTurn.pollUnsafe());

      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.join(install);
      yield* Fiber.join(codexTurn);
      assert.strictEqual(yield* gate.installsInFlight, 0);
    }).pipe(Effect.provide(layerGate({ current: false }))),
  );

  it.effect("holds turn starts while another server holds the installer's lock", () => {
    const remoteHeld = { current: true };
    return Effect.gen(function* () {
      const gate = yield* ProviderInstallGate.ProviderInstallGate;
      const turn = yield* gate
        .awaitInstance(ProviderInstanceId.make("claude"))
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      assert.isUndefined(turn.pollUnsafe());

      remoteHeld.current = false;
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(turn);
      assert.strictEqual(yield* gate.installsInFlight, 0);
    }).pipe(Effect.provide(layerGate(remoteHeld)));
  });
});
