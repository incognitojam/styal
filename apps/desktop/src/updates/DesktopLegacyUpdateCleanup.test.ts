import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Ref from "effect/Ref";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import { flushCallbacks, makeHarness } from "./updatesTestHarness.ts";

describe("native updater lifecycle", () => {
  it.effect(
    "removes an inherited waiting transaction before downloads, including a newer manual overlay",
    () => {
      const harness = makeHarness({ inheritedShipItRequest: "1.2.4", appVersion: "1.2.5" });
      return Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          assert.isFalse(harness.squirrel.job);
          assert.equal(harness.squirrel.request, "1.2.4");
          assert.isTrue((yield* updates.setChannel("nightly")).enabled);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    },
  );
  it.effect("downloads only on request without staging an installation", () => {
    const harness = makeHarness();
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-available", { version: "1.2.4" });
        yield* flushCallbacks;
        assert.equal(harness.downloadCount(), 0);
        yield* updates.download;
        assert.equal(harness.downloadCount(), 1);
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;
        assert.equal(harness.squirrel.stageCount, 0);
        assert.isFalse(harness.squirrel.job);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });
  it.effect(
    "recovers from a stalled native stage and discards its late completion before another action",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const discarded = yield* Deferred.make<void>();
        const harness = makeHarness({
          nativeStageWait: Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
          ),
          afterNativeDiscard: Deferred.succeed(discarded, undefined).pipe(Effect.asVoid),
          downloadUpdate: Effect.sync(() =>
            harness.emit("update-downloaded", { version: "1.2.4" }),
          ),
        });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const updates = yield* DesktopUpdates.DesktopUpdates;
            const desktopState = yield* DesktopState.DesktopState;
            yield* updates.configure;
            harness.emit("update-downloaded", { version: "1.2.4" });
            yield* flushCallbacks;
            const install = yield* updates.installPrepared("1.2.4").pipe(Effect.forkScoped);
            yield* Deferred.await(started);
            yield* TestClock.adjust("90 seconds");
            assert.isTrue((yield* Fiber.join(install)).failed);
            assert.isFalse(yield* Ref.get(desktopState.quitting));
            assert.deepEqual(harness.installSteps, []);
            assert.isFalse((yield* updates.check("manual")).checked);
            yield* Deferred.succeed(release, undefined);
            yield* Deferred.await(discarded);
            assert.isFalse(harness.squirrel.job);
            assert.isNull((yield* updates.getState).downloadedVersion);
            assert.isFalse((yield* updates.installPrepared("1.2.4")).accepted);
            assert.isTrue((yield* updates.download).completed);
            assert.isTrue((yield* updates.installPrepared("1.2.4")).accepted);
            assert.deepEqual(harness.squirrel.installedOnExit, ["1.2.4"]);
          }),
        ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
      }),
  );

  it.effect("does not restart after quit is accepted while native staging finishes", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const harness = makeHarness({
        quitUpdateResponse: 1,
        nativeStageWait: Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        ),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* flushCallbacks;
          const install = yield* updates.installPrepared("1.2.4").pipe(Effect.forkScoped);
          yield* Deferred.await(started);
          assert.isTrue(yield* updates.prepareForQuit());
          yield* Deferred.succeed(release, undefined);
          assert.isFalse((yield* Fiber.join(install)).accepted);
          assert.deepEqual(harness.installSteps, []);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );
  it.effect("does not hand off an install while a cancellable quit confirmation is open", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const quitStarted = yield* Deferred.make<void>();
      const quitRelease = yield* Deferred.make<void>();
      const harness = makeHarness({
        quitUpdateResponse: 1,
        nativeStageWait: Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        ),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* flushCallbacks;
          const install = yield* updates.installPrepared("1.2.4").pipe(Effect.forkScoped);
          yield* Deferred.await(started);
          const quit = yield* updates
            .prepareForQuit(
              Deferred.succeed(quitStarted, undefined).pipe(
                Effect.andThen(Deferred.await(quitRelease)),
                Effect.as(false),
              ),
            )
            .pipe(Effect.forkScoped);
          yield* Deferred.await(quitStarted);
          yield* Deferred.succeed(release, undefined);
          assert.isFalse((yield* Fiber.join(install)).accepted);
          assert.deepEqual(harness.installSteps, []);
          assert.isFalse(harness.squirrel.job);
          assert.isNull((yield* updates.getState).downloadedVersion);
          yield* Deferred.succeed(quitRelease, undefined);
          assert.isFalse(yield* Fiber.join(quit));
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );
  it.effect("keeps an accepted quit authoritative through the final activity confirmation", () =>
    Effect.gen(function* () {
      const postStageCheck = yield* Deferred.make<void>();
      const releaseCheck = yield* Deferred.make<void>();
      let checks = 0;
      const harness = makeHarness({
        quitUpdateResponse: 1,
        confirmShutdown: Effect.suspend(() => {
          checks += 1;
          return checks === 2
            ? Deferred.succeed(postStageCheck, undefined).pipe(
                Effect.andThen(Deferred.await(releaseCheck)),
                Effect.as(true),
              )
            : Effect.succeed(true);
        }),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* flushCallbacks;
          const install = yield* updates.install.pipe(Effect.forkScoped);
          yield* Deferred.await(postStageCheck);
          assert.isTrue(yield* updates.prepareForQuit());
          yield* Deferred.succeed(releaseCheck, undefined);
          const result = yield* Fiber.join(install);
          assert.isFalse(result.accepted);
          assert.deepEqual(harness.installSteps, []);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  it.effect.each(["stage-fails", "caller-interrupted"] as const)(
    "does not clear an ordinary quit during late install cleanup: %s",
    (mode) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const discarded = yield* Deferred.make<void>();
        const harness = makeHarness({
          quitUpdateResponse: 1,
          nativeStageUnavailable: () => mode === "stage-fails",
          nativeStageWait: Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
          ),
          afterNativeDiscard: Deferred.succeed(discarded, undefined).pipe(Effect.asVoid),
        });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const updates = yield* DesktopUpdates.DesktopUpdates;
            const state = yield* DesktopState.DesktopState;
            yield* updates.configure;
            harness.emit("update-downloaded", { version: "1.2.4" });
            yield* flushCallbacks;
            const install = yield* updates.installPrepared("1.2.4").pipe(Effect.forkScoped);
            yield* Deferred.await(started);
            assert.isTrue(yield* updates.prepareForQuit());
            if (mode === "caller-interrupted") yield* Fiber.interrupt(install);
            yield* Deferred.succeed(release, undefined);
            if (mode === "stage-fails") assert.isTrue((yield* Fiber.join(install)).failed);
            yield* Deferred.await(discarded);
            assert.isTrue(yield* Ref.get(state.quitting));
            assert.deepEqual(harness.installSteps, []);
          }),
        ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
      }),
  );
  it.effect.each([false, true])(
    "cleans inherited user jobs even when policy disables updates: %s",
    (disabled) => {
      const harness = makeHarness({
        inheritedShipItRequest: "1.2.2",
        ...(disabled
          ? {
              policy: {
                mode: "off" as const,
                feedUrl: undefined,
                allowNightly: true,
                message: "Updates managed by Synthetic Organization",
              },
            }
          : {}),
      });
      return Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          assert.isFalse(harness.squirrel.job);
          assert.isTrue(yield* updates.prepareForQuit());
          assert.equal((yield* updates.getState).enabled, !disabled);
          assert.equal(harness.squirrel.stageCount, 0);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    },
  );
  it.effect(
    "refuses unsafe quit, install and channel changes while leaving checks and downloads available",
    () => {
      const harness = makeHarness({
        inheritedShipItRequest: "1.2.2",
        inheritedNativeJobActive: true,
      });
      return Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          assert.isTrue(harness.squirrel.job);
          assert.isTrue((yield* updates.check("manual")).checked);
          assert.isFalse(yield* updates.prepareForQuit());
          assert.lengthOf(harness.refusalDialogs, 1);
          yield* updates.setChannel("nightly").pipe(Effect.flip);
          assert.equal((yield* updates.getState).channel, "latest");
          harness.emit("update-available", { version: "1.2.5" });
          yield* flushCallbacks;
          yield* updates.download;
          assert.equal(harness.downloadCount(), 1);
          harness.emit("update-downloaded", { version: "1.2.5" });
          yield* flushCallbacks;
          assert.isTrue((yield* updates.installPrepared("1.2.5")).failed);
          assert.equal(harness.squirrel.stageCount, 0);
          assert.deepEqual(harness.installSteps, []);
          // The inherited transaction finishes outside this process; a later action re-inspects it.
          harness.squirrel.job = false;
          assert.isTrue(yield* updates.prepareForQuit());
          assert.equal((yield* updates.setChannel("nightly")).channel, "nightly");
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    },
  );
  it.effect.each([false, true])(
    "recreates a spent native feed after failed explicit staging or handoff: %s",
    (stageFails) => {
      let unavailable = stageFails;
      let handoffFails = !stageFails;
      const harness = makeHarness({
        nativeStageUnavailable: () => unavailable,
        quitAndInstall: Effect.suspend(() =>
          handoffFails
            ? Effect.fail(
                new ElectronUpdater.ElectronUpdaterQuitAndInstallError({
                  channel: "latest",
                  isSilent: true,
                  isForceRunAfter: true,
                  cause: new Error("handoff failed"),
                }),
              )
            : Effect.void,
        ),
        downloadUpdate: Effect.sync(() => harness.emit("update-downloaded", { version: "1.2.4" })),
      });
      return Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* flushCallbacks;
          assert.isTrue((yield* updates.installPrepared("1.2.4")).failed);
          assert.isFalse(harness.squirrel.job);
          assert.isNull((yield* updates.getState).downloadedVersion);
          assert.isFalse((yield* updates.installPrepared("1.2.4")).accepted);
          unavailable = false;
          handoffFails = false;
          assert.isTrue((yield* updates.download).completed);
          assert.isTrue((yield* updates.installPrepared("1.2.4")).accepted);
          assert.equal(harness.squirrel.installedOnExit.at(-1), "1.2.4");
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    },
  );
  it.effect("does not stage before local restart consent", () => {
    const harness = makeHarness({ confirmShutdown: Effect.succeed(false) });
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;
        assert.isFalse((yield* updates.install).accepted);
        assert.equal(harness.squirrel.stageCount, 0);
        assert.deepEqual(harness.installSteps, []);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect(
    "keeps the service-owned stage alive after caller interruption and permits a later channel switch",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const discarded = yield* Deferred.make<void>();
        const harness = makeHarness({
          nativeStageWait: Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
          ),
          afterNativeDiscard: Deferred.succeed(discarded, undefined).pipe(Effect.asVoid),
        });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const updates = yield* DesktopUpdates.DesktopUpdates;
            yield* updates.configure;
            harness.emit("update-downloaded", { version: "1.2.4" });
            yield* flushCallbacks;
            const install = yield* updates.installPrepared("1.2.4").pipe(Effect.forkScoped);
            yield* Deferred.await(started);
            yield* Fiber.interrupt(install);
            assert.isFalse((yield* updates.check("manual")).checked);
            assert.isFalse(yield* updates.prepareForQuit());
            const { changes } = yield* updates.subscribe;
            const recovered = yield* changes.pipe(
              Stream.filter((state) => state.downloadedVersion === null),
              Stream.runHead,
              Effect.forkScoped,
            );
            yield* Deferred.succeed(release, undefined);
            yield* Deferred.await(discarded);
            yield* Fiber.join(recovered);
            assert.isFalse(harness.squirrel.job);
            assert.isNull((yield* updates.getState).downloadedVersion);
            assert.equal((yield* updates.setChannel("nightly")).channel, "nightly");
            assert.deepEqual(harness.installSteps, []);
          }),
        ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
      }),
  );
  it.effect.each(["ask", "require-safe"] as const)(
    "rechecks %s activity after native staging before stopping backends",
    (consent) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const harness = makeHarness({
          confirmShutdown: Effect.sync(() => harness.activity.hosts[0] !== null),
          nativeStageWait: Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
          ),
        });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const updates = yield* DesktopUpdates.DesktopUpdates;
            yield* updates.configure;
            harness.emit("update-downloaded", { version: "1.2.4" });
            yield* flushCallbacks;
            const install = yield* (
              consent === "ask" ? updates.install : updates.installPrepared("1.2.4", "require-safe")
            ).pipe(Effect.forkScoped);
            yield* Deferred.await(started);
            harness.activity.hosts = [null];
            yield* Deferred.succeed(release, undefined);
            assert.isFalse((yield* Fiber.join(install)).accepted);
            assert.isFalse(harness.squirrel.job);
            assert.isNull((yield* updates.getState).errorContext);
            assert.deepEqual(harness.installSteps, []);
          }),
        ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
      }),
  );
  it.effect("reserves quit through confirmation and releases it after cancellation", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const harness = makeHarness();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          const state = yield* DesktopState.DesktopState;
          yield* updates.configure;
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* flushCallbacks;
          const quit = yield* updates
            .prepareForQuit(
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as(false),
              ),
            )
            .pipe(Effect.forkScoped);
          yield* Deferred.await(started);
          assert.isFalse((yield* updates.installPrepared("1.2.4")).accepted);
          assert.equal(harness.squirrel.stageCount, 0);
          yield* Deferred.succeed(release, undefined);
          assert.isFalse(yield* Fiber.join(quit));
          assert.isFalse(yield* Ref.get(state.quitting));
          assert.isTrue((yield* updates.installPrepared("1.2.4")).accepted);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );
  it.effect("drops native ownership after a successful quit preflight is cancelled", () => {
    let failRemoval = true;
    const harness = makeHarness({
      inheritedNativeJobActive: true,
      discardNativeUpdateFailure: () => failRemoval && harness.squirrel.stageCount > 0,
      installError: new ElectronUpdater.ElectronUpdaterQuitAndInstallError({
        channel: null,
        isSilent: true,
        isForceRunAfter: true,
        cause: new Error("handoff failed"),
      }),
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;
        assert.isTrue((yield* updates.installPrepared("1.2.4")).failed);
        assert.isTrue(harness.squirrel.job);
        failRemoval = false;
        assert.isFalse(yield* updates.prepareForQuit(Effect.succeed(false)));
        assert.isFalse(harness.squirrel.job);
        harness.squirrel.job = true;
        assert.isFalse(yield* updates.prepareForQuit());
        assert.isTrue(harness.squirrel.job);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });
  it.effect.each([0, 1])(
    "offers an informed quit choice for an inherited installer: %s",
    (response) => {
      const harness = makeHarness({
        inheritedShipItRequest: "1.2.2",
        inheritedNativeJobActive: true,
        quitUpdateResponse: response,
      });
      return Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          const state = yield* DesktopState.DesktopState;
          yield* updates.configure;
          assert.equal(yield* updates.prepareForQuit(), response === 1);
          assert.equal(yield* Ref.get(state.quitting), response === 1);
          assert.isTrue(harness.squirrel.job);
          assert.equal(harness.squirrel.request, "1.2.2");
          assert.include(harness.refusalDialogs[0], "older than the version");
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    },
  );
});
