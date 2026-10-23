import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { DesktopFeatureUsageReport } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopLaunchTiming from "./DesktopLaunchTiming.ts";
import * as DesktopTelemetryPublisher from "./DesktopTelemetryPublisher.ts";

const environmentLayer = (appVersion: string, platform: NodeJS.Platform = "darwin") =>
  DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/dist-electron",
    homeDirectory: "/Users/alice",
    platform,
    processArch: "arm64",
    appVersion,
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/repo/resources",
    runningUnderArm64Translation: false,
  }).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({}))));

// Files that survive between the simulated processes of one test.
const makeFiles = () => {
  const files = new Map<string, string>();
  const layer = FileSystem.layerNoop({
    makeDirectory: () => Effect.void,
    readFileString: (path) =>
      Effect.suspend(() => {
        const contents = files.get(path);
        return contents === undefined
          ? Effect.fail(
              PlatformError.systemError({
                module: "FileSystem",
                method: "readFileString",
                _tag: "NotFound",
                pathOrDescriptor: path,
              }),
            )
          : Effect.succeed(contents);
      }),
    writeFileString: (path, contents) => Effect.sync(() => void files.set(path, contents)),
    remove: (path) => Effect.sync(() => void files.delete(path)),
  });
  return { files, layer };
};

const launch = (
  files: ReturnType<typeof makeFiles>,
  input: { readonly appVersion: string; readonly processStartedAt: number },
) =>
  DesktopLaunchTiming.make({ processStartedAt: input.processStartedAt }).pipe(
    Effect.provide(Layer.mergeAll(environmentLayer(input.appVersion), files.layer)),
  );

describe("DesktopLaunchTiming", () => {
  it.effect("reports a normal launch from the process start", () =>
    Effect.gen(function* () {
      const timing = yield* launch(makeFiles(), { appVersion: "1.2.3", processStartedAt: 1_000 });
      yield* TestClock.setTime(3_000);
      yield* timing.markBackendReady;
      yield* TestClock.setTime(4_000);
      yield* timing.markWindowShown;
      // A backend restart or a reopened window later in the run changes nothing.
      yield* TestClock.setTime(60_000);
      yield* timing.markBackendReady;
      yield* timing.markWindowShown;

      assert.deepEqual(yield* timing.report, {
        version: 1,
        type: "desktopFeatureUsage",
        feature: "desktop-launch",
        action: "launched",
        platform: "darwin",
        backendReadyMs: 2_000,
        windowShownMs: 3_000,
      });
    }),
  );

  it.effect("reports an update restart on the launch of the version it installed", () =>
    Effect.gen(function* () {
      const files = makeFiles();
      const before = yield* launch(files, { appVersion: "1.2.3", processStartedAt: 0 });
      yield* TestClock.setTime(10_000);
      yield* before.recordUpdateRestart({
        toVersion: "1.2.4",
        requestedAt: 8_500,
        stagedInBackground: true,
      });

      const after = yield* launch(files, { appVersion: "1.2.4", processStartedAt: 13_000 });
      assert.equal(files.files.size, 0);
      yield* TestClock.setTime(14_000);
      yield* after.markBackendReady;
      yield* TestClock.setTime(14_500);
      yield* after.markWindowShown;

      const report = yield* after.report;
      assert.equal(report.windowShownMs, 1_500);
      assert.deepEqual(report.update, {
        stopMs: 1_500,
        relaunchMs: 3_000,
        stagedInBackground: true,
      });
    }),
  );

  it.effect("drops the restart record when the install did not apply", () =>
    Effect.gen(function* () {
      const files = makeFiles();
      const before = yield* launch(files, { appVersion: "1.2.3", processStartedAt: 0 });
      yield* before.recordUpdateRestart({
        toVersion: "1.2.4",
        requestedAt: 0,
        stagedInBackground: false,
      });

      const after = yield* launch(files, { appVersion: "1.2.3", processStartedAt: 5_000 });
      assert.equal(files.files.size, 0);
      yield* TestClock.setTime(6_000);
      yield* after.markWindowShown;

      const report = yield* after.report;
      assert.isUndefined(report.update);
      // No backend became ready, as when the local environment is off.
      assert.isNull(report.backendReadyMs);
    }),
  );

  it.effect("sends the report through the telemetry pipe once the window is shown", () =>
    Effect.gen(function* () {
      const published = yield* Deferred.make<DesktopFeatureUsageReport>();
      const timing = yield* launch(makeFiles(), { appVersion: "1.2.3", processStartedAt: 0 });
      const telemetry = Layer.mock(DesktopTelemetryPublisher.DesktopTelemetryPublisher)({
        publishFeatureUsage: (report) => Deferred.succeed(published, report).pipe(Effect.asVoid),
        updateRequests: Stream.empty,
      });
      yield* Layer.build(
        DesktopLaunchTiming.layerReporter.pipe(
          Layer.provide(Layer.succeed(DesktopLaunchTiming.DesktopLaunchTiming, timing)),
          Layer.provide(telemetry),
        ),
      );
      assert.isFalse(yield* Deferred.isDone(published));

      yield* TestClock.setTime(2_000);
      yield* timing.markWindowShown;
      const report = yield* Deferred.await(published);
      assert.equal(report.feature, "desktop-launch");
    }),
  );
});
