import { assert, describe, it } from "@effect/vitest";
import type { DesktopFeatureUsageReport, DesktopIdleRestartDelayBucket } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopIdleRestart from "./DesktopIdleRestart.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";

import { quietHost } from "./nativeUpdatesTestFakes.ts";
import { flushCallbacks, makeHarness } from "./updatesTestHarness.ts";

describe("idle restart measurement", () => {
  const tick = TestClock.adjust("30 seconds").pipe(Effect.andThen(flushCallbacks));
  const report = (
    delayBucket: DesktopIdleRestartDelayBucket,
    updateVersion = "1.2.4",
  ): DesktopFeatureUsageReport => ({
    version: 1,
    type: "desktopFeatureUsage",
    feature: "desktop-update-idle-restart",
    action: "would_restart",
    updateVersion,
    delayBucket,
  });
  // Checks keep polling while an update is staged; each finds the same release.
  const makeStagingHarness = () => {
    const harness = makeHarness({
      stagesInBackground: true,
      checkForUpdates: Effect.sync(() => harness.emit("update-available", { version: "1.2.4" })),
    });
    return harness;
  };
  const withStagedUpdate = <E, R>(
    harness: ReturnType<typeof makeHarness>,
    body: (updates: DesktopUpdates.DesktopUpdates["Service"]) => Effect.Effect<void, E, R>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;
        yield* body(updates);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));

  it("buckets the delay since staging", () => {
    const hour = 3_600_000;
    assert.equal(DesktopIdleRestart.idleRestartDelayBucket(0), "<1h");
    assert.equal(DesktopIdleRestart.idleRestartDelayBucket(hour - 1), "<1h");
    assert.equal(DesktopIdleRestart.idleRestartDelayBucket(hour), "1-8h");
    assert.equal(DesktopIdleRestart.idleRestartDelayBucket(8 * hour - 1), "1-8h");
    assert.equal(DesktopIdleRestart.idleRestartDelayBucket(8 * hour), "8-24h");
    assert.equal(DesktopIdleRestart.idleRestartDelayBucket(24 * hour - 1), "8-24h");
    assert.equal(DesktopIdleRestart.idleRestartDelayBucket(24 * hour), ">24h");
  });

  it.effect("records the first idle moment once and never installs", () => {
    const harness = makeStagingHarness();
    return withStagedUpdate(harness, (updates) =>
      Effect.gen(function* () {
        assert.equal(harness.idleRestart.pendingFile, "1.2.4");
        harness.idleRestart.idleState = "idle";
        yield* tick;
        assert.deepEqual(harness.idleRestart.reports, [report("<1h")]);
        assert.isUndefined(harness.idleRestart.pendingFile);

        yield* tick;
        yield* tick;
        assert.equal(harness.idleRestart.reports.length, 1);
        assert.equal(harness.idleRestart.inspections, 1);
        assert.equal(harness.quitAndInstalls(), 0);
        assert.equal((yield* updates.getState).status, "downloaded");
      }),
    );
  });

  it.effect("waits for the user to go idle and counts a locked screen as idle", () => {
    const harness = makeStagingHarness();
    return withStagedUpdate(harness, () =>
      Effect.gen(function* () {
        yield* TestClock.adjust("2 hours");
        assert.deepEqual(harness.idleRestart.reports, []);
        assert.equal(harness.idleRestart.inspections, 0);

        harness.idleRestart.idleState = "unknown";
        yield* tick;
        assert.deepEqual(harness.idleRestart.reports, []);

        harness.idleRestart.idleState = "locked";
        yield* tick;
        assert.deepEqual(harness.idleRestart.reports, [report("1-8h")]);
      }),
    );
  });

  it.effect.each([
    ["a waiting approval or question", { ...quietHost, waitingSessions: 1 }],
    ["a provider install", { ...quietHost, providerInstalls: 1 }],
    ["devices used by another environment", { ...quietHost, environmentsUsingDevices: 1 }],
    ["a host that could not be checked", null],
  ] as const)("holds off while there is %s", ([, blockingHost]) => {
    const harness = makeStagingHarness();
    return withStagedUpdate(harness, () =>
      Effect.gen(function* () {
        harness.idleRestart.idleState = "idle";
        harness.idleRestart.hosts = [quietHost, blockingHost];
        yield* tick;
        yield* tick;
        assert.deepEqual(harness.idleRestart.reports, []);
        assert.equal(harness.idleRestart.inspections, 2);

        harness.idleRestart.hosts = [quietHost, quietHost];
        yield* tick;
        yield* tick;
        assert.deepEqual(harness.idleRestart.reports, [report("<1h")]);
      }),
    );
  });

  it.effect("waits for turns that will not resume, but not for terminal commands", () => {
    const harness = makeStagingHarness();
    return withStagedUpdate(harness, () =>
      Effect.gen(function* () {
        harness.idleRestart.idleState = "idle";
        const busyHost = {
          ...quietHost,
          activeSessions: 2,
          continuableSessions: 1,
          terminalsRequiringConfirmation: 1,
          terminalsWithUnknownActivity: 1,
        };
        harness.idleRestart.hosts = [busyHost];
        yield* tick;
        assert.deepEqual(harness.idleRestart.reports, []);

        harness.idleRestart.hosts = [{ ...busyHost, continuableSessions: 2 }];
        yield* tick;
        assert.deepEqual(harness.idleRestart.reports, [report("<1h")]);
      }),
    );
  });

  it.effect("records nothing when the user returns during the activity check", () => {
    const harness = makeStagingHarness();
    return withStagedUpdate(harness, () =>
      Effect.gen(function* () {
        harness.idleRestart.idleState = "idle";
        harness.idleRestart.onInspect = () => {
          harness.idleRestart.idleState = "active";
        };
        yield* tick;
        assert.equal(harness.idleRestart.inspections, 1);
        assert.deepEqual(harness.idleRestart.reports, []);
        assert.equal(harness.idleRestart.pendingFile, "1.2.4");
      }),
    );
  });

  it.effect("measures only updates staged in the background", () => {
    const harness = makeHarness({ stagesInBackground: false });
    return withStagedUpdate(harness, () =>
      Effect.gen(function* () {
        harness.idleRestart.idleState = "idle";
        yield* tick;
        assert.equal(harness.idleRestart.inspections, 0);
        assert.deepEqual(harness.idleRestart.reports, []);
        assert.isUndefined(harness.idleRestart.pendingFile);
      }),
    );
  });

  it.effect("measures nothing outside macOS", () => {
    const harness = makeHarness({ platform: "win32" });
    return withStagedUpdate(harness, (updates) =>
      Effect.gen(function* () {
        assert.equal((yield* updates.getState).status, "downloaded");
        harness.idleRestart.idleState = "idle";
        yield* tick;
        assert.equal(harness.idleRestart.inspections, 0);
        assert.deepEqual(harness.idleRestart.reports, []);
      }),
    );
  });

  it.effect("skips checks while quitting", () => {
    const harness = makeStagingHarness();
    return withStagedUpdate(harness, () =>
      Effect.gen(function* () {
        const desktopState = yield* DesktopState.DesktopState;
        harness.idleRestart.idleState = "idle";
        yield* Ref.set(desktopState.quitting, true);
        yield* tick;
        assert.equal(harness.idleRestart.inspections, 0);
        assert.deepEqual(harness.idleRestart.reports, []);
      }),
    );
  });

  it.effect("skips checks while an update action is in progress", () =>
    Effect.gen(function* () {
      const installing = yield* Deferred.make<void>();
      const harness = makeHarness({
        stagesInBackground: true,
        installWait: Deferred.succeed(installing, undefined).pipe(Effect.andThen(Effect.never)),
      });
      yield* withStagedUpdate(harness, (updates) =>
        Effect.gen(function* () {
          yield* updates.install.pipe(Effect.forkChild);
          yield* Deferred.await(installing);
          assert.isTrue(yield* updates.isActionActive);
          harness.idleRestart.idleState = "idle";
          yield* tick;
          assert.equal(harness.idleRestart.inspections, 0);
          assert.deepEqual(harness.idleRestart.reports, []);
        }),
      );
    }),
  );

  it.effect("records never for a staged update discarded by a channel change", () => {
    const harness = makeStagingHarness();
    return withStagedUpdate(harness, (updates) =>
      Effect.gen(function* () {
        yield* updates.setChannel("nightly");
        assert.deepEqual(harness.idleRestart.reports, [report("never")]);
        assert.isUndefined(harness.idleRestart.pendingFile);

        harness.idleRestart.idleState = "idle";
        yield* tick;
        assert.equal(harness.idleRestart.reports.length, 1);
      }),
    );
  });

  it.effect("records installed_first when the next launch runs the pending version", () => {
    const harness = makeStagingHarness();
    harness.idleRestart.pendingFile = "1.2.3";
    return Effect.scoped(
      Effect.gen(function* () {
        yield* (yield* DesktopUpdates.DesktopUpdates).configure;
        assert.deepEqual(harness.idleRestart.reports, [report("installed_first", "1.2.3")]);
        assert.isUndefined(harness.idleRestart.pendingFile);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("keeps the pending version across a quit and records never on the next launch", () => {
    const harness = makeStagingHarness();
    return Effect.gen(function* () {
      yield* withStagedUpdate(harness, () => Effect.void);
      assert.equal(harness.idleRestart.pendingFile, "1.2.4");
      assert.deepEqual(harness.idleRestart.reports, []);

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* (yield* DesktopUpdates.DesktopUpdates).configure;
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
      assert.deepEqual(harness.idleRestart.reports, [report("never")]);
      assert.isUndefined(harness.idleRestart.pendingFile);
    });
  });
});
