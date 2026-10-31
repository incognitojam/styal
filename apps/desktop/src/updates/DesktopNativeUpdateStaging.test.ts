import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopNativeUpdateStaging from "./DesktopNativeUpdateStaging.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";

import { flushCallbacks, makeHarness } from "./updatesTestHarness.ts";

describe("macOS background staging", () => {
  const nightly = "1.2.4-nightly.20260820.1";
  const run = <E>(
    harness: ReturnType<typeof makeHarness>,
    body: (
      updates: DesktopUpdates.DesktopUpdates["Service"],
      quit: Effect.Effect<boolean>,
    ) => Effect.Effect<void, E>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        const desktopState = yield* DesktopState.DesktopState;
        yield* updates.configure;
        yield* body(
          updates,
          Ref.set(desktopState.quitting, true).pipe(Effect.andThen(updates.installOnQuit)),
        );
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));

  it.effect("stages a download once and keeps it when checks find the same release", () => {
    const harness = makeHarness({
      stagesInBackground: true,
      checkForUpdates: Effect.sync(() => harness.emit("update-available", { version: "1.2.4" })),
    });
    return run(harness, (updates, quit) =>
      Effect.gen(function* () {
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;
        assert.equal(harness.squirrel.stageCount, 1);
        assert.isTrue(harness.squirrel.job);

        assert.isTrue((yield* updates.check("manual")).checked);
        yield* flushCallbacks;
        assert.equal(harness.downloadCount(), 0);
        assert.equal(harness.squirrel.discardCount, 0);
        assert.equal((yield* updates.getState).status, "downloaded");

        assert.isTrue(yield* quit);
        assert.equal(harness.squirrel.stageCount, 1);
        assert.deepEqual(harness.squirrel.installedOnExit, ["1.2.4"]);
        assert.isFalse(harness.autoInstallOnAppQuit());
      }),
    );
  });

  it.effect("replaces a staged update when a newer release appears", () => {
    const harness = makeHarness({
      stagesInBackground: true,
      checkForUpdates: Effect.sync(() => harness.emit("update-available", { version: "1.2.5" })),
      downloadUpdate: Effect.sync(() => harness.emit("update-downloaded", { version: "1.2.5" })),
    });
    return run(harness, (updates, quit) =>
      Effect.gen(function* () {
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;
        assert.equal(harness.squirrel.stageCount, 1);

        assert.isTrue((yield* updates.check("poll")).checked);
        yield* flushCallbacks;
        assert.equal(harness.squirrel.discardCount, 1);
        assert.equal(harness.downloadCount(), 1);
        assert.equal(harness.squirrel.stageCount, 2);
        assert.equal((yield* updates.getState).downloadedVersion, "1.2.5");

        assert.isTrue(yield* quit);
        assert.deepEqual(harness.squirrel.installedOnExit, ["1.2.5"]);
      }),
    );
  });

  it.effect("keeps the staged update when it cannot be discarded for a newer release", () => {
    const harness = makeHarness({
      stagesInBackground: true,
      discardNativeUpdateFailure: "job-removal",
      checkForUpdates: Effect.sync(() => harness.emit("update-available", { version: "1.2.5" })),
    });
    return run(harness, (updates, quit) =>
      Effect.gen(function* () {
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        assert.isTrue((yield* updates.check("poll")).checked);
        yield* flushCallbacks;
        assert.equal(harness.downloadCount(), 0);
        const state = yield* updates.getState;
        assert.equal(state.status, "downloaded");
        assert.equal(state.downloadedVersion, "1.2.4");

        assert.isTrue(yield* quit);
        assert.deepEqual(harness.squirrel.installedOnExit, ["1.2.4"]);
      }),
    );
  });

  it.effect("hands off only after staging in progress finishes", () =>
    Effect.gen(function* () {
      const staging = yield* Deferred.make<void>();
      const harness = makeHarness({
        stagesInBackground: true,
        beforeNativeStageOutcome: Deferred.await(staging),
      });
      yield* run(harness, (_updates, quit) =>
        Effect.gen(function* () {
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* flushCallbacks;
          const install = yield* quit.pipe(Effect.forkChild);
          yield* flushCallbacks;
          assert.equal(harness.quitAndInstalls(), 0);

          yield* Deferred.succeed(staging, undefined);
          assert.isTrue(yield* Fiber.join(install));
          assert.deepEqual(harness.squirrel.installedOnExit, ["1.2.4"]);
        }),
      );
    }),
  );

  it.effect.each(["before-request", "after-request"] as const)(
    "leaves a staging that failed %s to staging at quit",
    (failure) => {
      let stagingFails = true;
      const harness = makeHarness({
        stagesInBackground: true,
        nativeStageFailure: () => (stagingFails ? failure : undefined),
      });
      return run(harness, (updates, quit) =>
        Effect.gen(function* () {
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* flushCallbacks;
          const state = yield* updates.getState;
          assert.equal(state.status, "downloaded");
          assert.isNull(state.message);
          assert.isFalse(harness.squirrel.job);

          stagingFails = false;
          assert.isTrue(yield* quit);
          // Staged again on the same native updater, as quit did before.
          assert.equal(harness.squirrel.stageCount, 2);
          assert.deepEqual(harness.squirrel.installedOnExit, ["1.2.4"]);
        }),
      );
    },
  );

  it.effect.each(["install", "installPrepared"] as const)(
    "recovers a %s restart whose quit-time staging finds no update",
    (entry) => {
      let failure: "before-request" | "not-available" = "before-request";
      const harness = makeHarness({
        stagesInBackground: true,
        nativeStageFailure: () => failure,
      });
      return run(harness, (updates) =>
        Effect.gen(function* () {
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* flushCallbacks;
          failure = "not-available";

          if (entry === "install") {
            yield* updates.install;
          } else {
            assert.isTrue((yield* updates.installPrepared("1.2.4")).failed);
          }
          assert.equal(harness.squirrel.stageCount, 2);
          assert.equal(harness.quitAndInstalls(), 0);
          // Install recovery restarted the stopped backends and released
          // the install, leaving the download to retry.
          assert.include(harness.installSteps, "startBackend");
          assert.isFalse(yield* updates.isActionActive);
          const state = yield* updates.getState;
          assert.equal(state.errorContext, "install");
          assert.equal(state.downloadedVersion, "1.2.4");
        }),
      );
    },
  );

  it.effect("removes a ShipIt job left by an earlier process when channels change", () => {
    const harness = makeHarness({
      stagesInBackground: true,
      inheritedShipItRequest: "1.2.3-nightly.20260801.1",
    });
    return run(harness, (updates, quit) =>
      Effect.gen(function* () {
        yield* updates.setChannel("nightly");
        assert.equal(harness.squirrel.discardCount, 1);
        assert.isFalse(harness.squirrel.job);
        assert.isFalse(yield* quit);
      }),
    );
  });

  it.effect("discards a staged update and its download before changing channels", () => {
    const harness = makeHarness({
      stagesInBackground: true,
      checkForUpdates: Effect.sync(() => harness.emit("update-not-available")),
    });
    return run(harness, (updates, quit) =>
      Effect.gen(function* () {
        yield* updates.setChannel("nightly");
        harness.emit("update-downloaded", { version: nightly });
        yield* flushCallbacks;
        assert.isTrue(harness.squirrel.job);

        yield* updates.setChannel("latest");
        // Each channel change discards, including the first with nothing staged.
        assert.equal(harness.squirrel.discardCount, 2);
        assert.isFalse(harness.squirrel.job);
        assert.isNull((yield* updates.getState).downloadedVersion);
        // A late old-channel event moves the feed but stages nothing.
        harness.emit("update-downloaded", { version: nightly });
        yield* flushCallbacks;
        assert.equal(harness.squirrel.stageCount, 1);

        // The new channel's download stages on its own fresh native updater.
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;
        assert.equal(harness.squirrel.stageCount, 2);
        assert.isTrue(yield* quit);
        assert.deepEqual(harness.squirrel.installedOnExit, ["1.2.4"]);
      }),
    );
  });

  it.effect("refuses the handoff when a download after a discard fails to stage", () => {
    let stagingFails = false;
    const harness = makeHarness({
      stagesInBackground: true,
      nativeStageFailure: () => (stagingFails ? "before-request" : undefined),
    });
    return run(harness, (updates, quit) =>
      Effect.gen(function* () {
        yield* updates.setChannel("nightly");
        harness.emit("update-downloaded", { version: nightly });
        yield* flushCallbacks;
        yield* updates.setChannel("latest");
        stagingFails = true;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        // MacUpdater's staged flag survives the discard, so its
        // quitAndInstall would quit without staging and install nothing.
        assert.isFalse(yield* quit);
        assert.equal(harness.quitAndInstalls(), 0);
        assert.isFalse(harness.squirrel.job);
      }),
    );
  });

  it.effect("keeps the channel and staged download when the ShipIt job cannot be removed", () => {
    const harness = makeHarness({
      stagesInBackground: true,
      discardNativeUpdateFailure: "job-removal",
    });
    return run(harness, (updates, quit) =>
      Effect.gen(function* () {
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;
        const error = yield* updates.setChannel("nightly").pipe(Effect.flip);
        assert.instanceOf(error, DesktopNativeUpdateStaging.DesktopUpdateStagedUpdateDiscardError);
        const state = yield* updates.getState;
        assert.equal(state.channel, "latest");
        assert.equal(state.downloadedVersion, "1.2.4");
        assert.equal(harness.checkCount(), 0);
        assert.isTrue(yield* quit);
        assert.deepEqual(harness.squirrel.installedOnExit, ["1.2.4"]);
      }),
    );
  });

  it.effect("treats a removed ShipIt job as discarded when its request remains", () => {
    const harness = makeHarness({
      stagesInBackground: true,
      discardNativeUpdateFailure: "request-removal",
    });
    return run(harness, (updates, quit) =>
      Effect.gen(function* () {
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;
        yield* updates.setChannel("nightly");
        assert.equal(harness.squirrel.request, "1.2.4");
        assert.isFalse(harness.squirrel.job);
        assert.isNull((yield* updates.getState).downloadedVersion);
        assert.isFalse(yield* quit);
      }),
    );
  });

  it.effect("clears a discarded download when the new channel cannot be saved", () => {
    const harness = makeHarness({
      stagesInBackground: true,
      setUpdateChannelError: new DesktopAppSettings.DesktopSettingsWriteError({
        operation: "replace-settings-file",
        path: "/tmp/settings.json",
        cause: new Error("disk full"),
      }),
    });
    return run(harness, (updates, quit) =>
      Effect.gen(function* () {
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;
        const error = yield* updates.setChannel("nightly").pipe(Effect.flip);
        assert.instanceOf(error, DesktopUpdates.DesktopUpdateChannelPersistenceError);
        const state = yield* updates.getState;
        assert.equal(state.channel, "latest");
        assert.isNull(state.downloadedVersion);
        assert.isFalse(yield* quit);
        assert.equal(harness.quitAndInstalls(), 0);
        assert.isFalse(harness.squirrel.job);
      }),
    );
  });

  it.effect("stages at quit when replacing the app needs administrator rights", () => {
    const harness = makeHarness({ stagesInBackground: false });
    return run(harness, (_updates, quit) =>
      Effect.gen(function* () {
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;
        assert.equal(harness.squirrel.stageCount, 0);
        assert.isTrue(yield* quit);
        assert.equal(harness.squirrel.stageCount, 1);
        assert.deepEqual(harness.squirrel.installedOnExit, ["1.2.4"]);
      }),
    );
  });

  it.effect("does not stage on Windows", () => {
    const harness = makeHarness({ platform: "win32", stagesInBackground: true });
    return run(harness, (_updates, quit) =>
      Effect.gen(function* () {
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;
        assert.isTrue(yield* quit);
        assert.equal(harness.squirrel.stageCount, 0);
      }),
    );
  });
});
