import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type DesktopUpdateActivity,
  DesktopUpdateActivityReport,
  type DesktopUpdateState,
  type DesktopUpdateStatusReport,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as DesktopAppUpdate from "./DesktopAppUpdate.ts";

const decodeActivityReport = Schema.decodeSync(DesktopUpdateActivityReport);

function makeState(overrides: Partial<DesktopUpdateState> = {}): DesktopUpdateState {
  return {
    enabled: true,
    status: "idle",
    channel: "latest",
    currentVersion: "1.2.3",
    hostArch: "arm64",
    appArch: "arm64",
    runningUnderArm64Translation: false,
    availableVersion: null,
    downloadedVersion: null,
    releaseNotes: [],
    downloadPercent: null,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: false,
    omittedReleaseCount: 0,
    ...overrides,
  };
}

function report(
  requestId: string,
  state: DesktopUpdateState,
  terminal?: {
    readonly outcome: DesktopUpdateStatusReport["outcome"];
    readonly reason?: string;
  },
): DesktopUpdateStatusReport {
  return {
    version: 1,
    type: "desktopUpdateStatus",
    requestId,
    ...(terminal?.outcome === undefined ? {} : { outcome: terminal.outcome }),
    ...(terminal?.reason === undefined ? {} : { reason: terminal.reason }),
    state,
  };
}

interface HarnessOptions {
  readonly mode?: "web" | "desktop";
  readonly controlFd?: number | undefined;
  readonly reports?: (requestId: string) => readonly DesktopUpdateStatusReport[];
  readonly keepOpen?: boolean;
  readonly activityHosts?: ReadonlyArray<DesktopUpdateActivity | null>;
  readonly activityRequest?: DesktopTelemetryReceiver.DesktopTelemetryReceiver["Service"]["requestUpdateActivity"];
  readonly legacyActivity?: boolean;
}

const makeHarness = Effect.fn("test.make_desktop_app_update_harness")(function* (
  options: HarnessOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-desktop-app-update-test-" });
  const requestIdDeferred = yield* Deferred.make<string>();
  const confirmations: boolean[] = [];
  const activityRequestId = yield* Deferred.make<string>();
  let subscribed = false;
  const activityReports = Effect.sync(() => {
    subscribed = true;
    return options.legacyActivity
      ? Stream.never
      : Stream.unwrap(
          Deferred.await(activityRequestId).pipe(
            Effect.map((requestId) => {
              const reports: ReadonlyArray<DesktopUpdateActivityReport> = [
                { version: 1, type: "desktopUpdateActivity", requestId: "unrelated", hosts: [] },
                {
                  version: 1,
                  type: "desktopUpdateActivity",
                  requestId,
                  hosts: decodeActivityReport({
                    version: 1,
                    type: "desktopUpdateActivity",
                    requestId,
                    hosts: options.activityHosts ?? [],
                  }).hosts,
                },
              ];
              return Stream.fromIterable(reports);
            }),
          ),
        );
  });
  const baseConfig = yield* ServerConfig.ServerConfig.pipe(
    Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
  );
  const config: ServerConfig.ServerConfig["Service"] = {
    ...baseConfig,
    mode: options.mode ?? "desktop",
    ...("controlFd" in options
      ? { desktopTelemetryControlFd: options.controlFd }
      : { desktopTelemetryControlFd: 5 }),
  };
  const reportsForRun = options.reports ?? (() => []);
  const changes = Stream.unwrap(
    Deferred.await(requestIdDeferred).pipe(
      Effect.map((requestId) => {
        const emitted = Stream.fromIterable(reportsForRun(requestId));
        return options.keepOpen ? Stream.concat(emitted, Stream.never) : emitted;
      }),
    ),
  );

  const service = yield* DesktopAppUpdate.make().pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(EnvironmentId.make("selected-environment")),
        }),
        DesktopTelemetryReceiver.layerTest({
          updateActivity: activityReports,
          requestUpdateActivity:
            options.activityRequest ??
            ((requestId, requestingEnvironmentId) =>
              Effect.gen(function* () {
                expect(requestingEnvironmentId).toBe("selected-environment");
                expect(subscribed).toBe(true);
                yield* Deferred.succeed(activityRequestId, requestId);
              })),
          requestDesktopUpdate: (requestId, confirmed = false) =>
            Effect.sync(() => {
              confirmations.push(confirmed);
            }).pipe(Effect.andThen(Deferred.succeed(requestIdDeferred, requestId)), Effect.asVoid),
          desktopUpdates: Effect.succeed({
            latest: Option.none<DesktopUpdateStatusReport>(),
            changes,
          }),
        }),
        ServerConfig.layer(config),
      ),
    ),
  );
  return { service, confirmations };
});

it.layer(NodeServices.layer)("desktop app update", (it) => {
  it.effect.each([undefined, true] as const)(
    "preserves explicit remote consent through preparation (%s)",
    (confirmed) =>
      Effect.gen(function* () {
        const { service, confirmations } = yield* makeHarness({
          reports: (requestId) => [
            report(requestId, makeState({ status: "downloaded", downloadedVersion: "1.2.4" }), {
              outcome: "ready-to-install",
            }),
          ],
        });
        yield* service.run(() => Effect.void, confirmed);
        expect(confirmations).toEqual([confirmed === true]);
      }),
  );

  it.effect(
    "preserves the primary marker and interruption counts through the wire schema and correlates replies",
    () =>
      Effect.gen(function* () {
        const idle = {
          activeSessions: 0,
          continuableSessions: 0,
          waitingSessions: 0,
          terminalsRequiringConfirmation: 0,
          terminalsWithUnknownActivity: 0,
          environmentsUsingDevices: 0,
        };
        const hosts = [
          { ...idle, isRequestingEnvironment: true },
          { ...idle, isRequestingEnvironment: false, terminalsRequiringConfirmation: 1 },
          null,
        ];
        const { service } = yield* makeHarness({ activityHosts: hosts });
        expect(yield* service.inspectActivity).toEqual([
          { ...idle, isRequestingEnvironment: true },
          { ...idle, isRequestingEnvironment: false, terminalsRequiringConfirmation: 1 },
          null,
        ]);
      }),
  );

  it.effect("treats unavailable and failed desktop activity checks as unknown", () =>
    Effect.gen(function* () {
      const unavailable = yield* makeHarness({ mode: "web" });
      expect(yield* unavailable.service.inspectActivity).toEqual([null]);
      const failed = yield* makeHarness({
        activityRequest: () =>
          Effect.fail(
            new DesktopTelemetryReceiver.DesktopTelemetryControlFailed({
              fd: 5,
              operation: "write",
              cause: new Error("pipe closed"),
            }),
          ),
      });
      expect(yield* failed.service.inspectActivity).toEqual([null]);
    }),
  );

  it.effect("bounds a legacy desktop app that never replies and requires confirmation", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness({ legacyActivity: true });
      const inspection = yield* service.inspectActivity.pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust("4 seconds");
      expect(yield* Fiber.join(inspection)).toEqual([null]);
    }),
  );

  it.effect("collapses state reports into progress stages and succeeds on installing", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness({
        reports: (requestId) => [
          report(requestId, makeState({ status: "checking" })),
          report(requestId, makeState({ status: "available", availableVersion: "1.2.4" })),
          report(requestId, makeState({ status: "downloading", downloadPercent: 40 })),
          report("other-run", makeState({ status: "error", message: "unrelated" })),
          report(requestId, makeState({ status: "downloaded", downloadedVersion: "1.2.4" }), {
            outcome: "ready-to-install",
          }),
        ],
      });
      const stages: string[] = [];
      const result = yield* service.run((stage) => Effect.sync(() => void stages.push(stage)));
      expect(result).toEqual({
        targetVersion: "1.2.4",
        method: "desktop-app",
        desktopUpdateToken: expect.any(String),
      });
      expect(stages).toEqual(["downloading", "installing"]);

      const retry = yield* service.run(() => Effect.void).pipe(Effect.flip);
      expect(retry.reason).not.toBe("A desktop app update is already in progress.");
    }),
  );

  it.effect("replays a retained commit failure for the preparation token", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness({
        reports: (requestId) => [
          report(requestId, makeState({ status: "downloaded", downloadedVersion: "1.2.4" }), {
            outcome: "ready-to-install",
          }),
          report(
            requestId,
            makeState({
              status: "downloaded",
              downloadedVersion: "1.2.4",
              errorContext: "install",
              message: "installer refused",
            }),
            { outcome: "failed", reason: "installer refused" },
          ),
        ],
      });
      const prepared = yield* service.run(() => Effect.void);

      expect(
        (yield* service.commit(prepared.desktopUpdateToken ?? "missing").pipe(Effect.flip)).reason,
      ).toBe("installer refused");
    }),
  );

  it.effect("fails when the desktop stops reporting before a terminal outcome", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness({
        reports: (requestId) => [report(requestId, makeState({ status: "checking" }))],
      });
      expect((yield* service.run(() => Effect.void).pipe(Effect.flip)).reason).toBe(
        "The desktop app stopped reporting its update.",
      );
    }),
  );

  it.effect("allows only one desktop update at a time", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness({ reports: () => [], keepOpen: true });
      const first = yield* Effect.forkChild(
        service.run(() => Effect.void),
        {
          startImmediately: true,
        },
      );
      expect((yield* service.run(() => Effect.void).pipe(Effect.flip)).reason).toBe(
        "A desktop app update is already in progress.",
      );
      yield* Fiber.interrupt(first);

      const retry = yield* Effect.forkChild(
        service.run(() => Effect.void),
        {
          startImmediately: true,
        },
      );
      yield* Effect.yieldNow;
      expect((yield* service.run(() => Effect.void).pipe(Effect.flip)).reason).toBe(
        "A desktop app update is already in progress.",
      );
      yield* Fiber.interrupt(retry);
    }),
  );
});
