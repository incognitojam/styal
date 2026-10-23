import type { DesktopLaunchTimingReport } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopTelemetryPublisher from "./DesktopTelemetryPublisher.ts";

const { logInfo } = DesktopObservability.makeComponentLogger("desktop-launch");

/** Saved in the runtime folder when an update restart hands off to the installer. */
const DESKTOP_UPDATE_RESTART_TIMING_FILE = "update-restart-timing.json";
const UpdateRestartTiming = Schema.fromJsonString(
  Schema.Struct({
    toVersion: Schema.String,
    requestedAt: Schema.Number,
    handedOffAt: Schema.Number,
    stagedInBackground: Schema.Boolean,
  }),
);
const decodeUpdateRestartTiming = Schema.decodeUnknownEffect(UpdateRestartTiming);
const encodeUpdateRestartTiming = Schema.encodeEffect(UpdateRestartTiming);

const reportedPlatform = (platform: NodeJS.Platform) =>
  platform === "darwin" || platform === "win32" ? platform : "linux";

/**
 * Times each desktop launch from the process start to the backend being ready
 * and the main window first being shown, and an update restart from the
 * user's request through the relaunch. `layerReporter` sends one report per
 * launch once the window shows.
 */
export class DesktopLaunchTiming extends Context.Service<
  DesktopLaunchTiming,
  {
    /** First call only: the local backend answered. */
    readonly markBackendReady: Effect.Effect<void>;
    /** First call only: the main window was shown. */
    readonly markWindowShown: Effect.Effect<void>;
    /** Runs just before an update restart hands off to the installer, so the
        next launch can report the restart. `requestedAt` is when the restart
        was accepted, before backends stopped. */
    readonly recordUpdateRestart: (input: {
      readonly toVersion: string;
      readonly requestedAt: number;
      readonly stagedInBackground: boolean;
    }) => Effect.Effect<void>;
    /** The report for this launch, once the main window has been shown. */
    readonly report: Effect.Effect<DesktopLaunchTimingReport>;
  }
>()("@t3tools/desktop/telemetry/DesktopLaunchTiming") {}

export const make = Effect.fn("desktop.launchTiming.make")(function* (options?: {
  readonly processStartedAt?: number;
}) {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const processStartedAt =
    options?.processStartedAt ??
    (yield* Clock.currentTimeMillis) - Math.round(process.uptime() * 1000);
  const runtimeDir = environment.path.join(environment.baseDir, "runtime");
  const timingPath = environment.path.join(runtimeDir, DESKTOP_UPDATE_RESTART_TIMING_FILE);

  const backendReadyAt = yield* Ref.make(Option.none<number>());
  const windowShownAt = yield* Deferred.make<number>();
  const sinceStart = (at: number) => Math.max(0, Math.round(at - processStartedAt));

  // The restart that started this process, read once and removed. A record
  // for another version is from an install that did not apply.
  const previousRestart = yield* fileSystem.readFileString(timingPath).pipe(
    Effect.flatMap(decodeUpdateRestartTiming),
    Effect.option,
    Effect.tap(() => fileSystem.remove(timingPath, { force: true }).pipe(Effect.ignore)),
    Effect.map(Option.filter((record) => record.toVersion === environment.appVersion)),
  );

  return DesktopLaunchTiming.of({
    markBackendReady: Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) =>
        Ref.update(backendReadyAt, (current) =>
          Option.isSome(current) ? current : Option.some(now),
        ),
      ),
    ),
    markWindowShown: Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) => Deferred.succeed(windowShownAt, now)),
      Effect.asVoid,
    ),
    recordUpdateRestart: (input) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((handedOffAt) => encodeUpdateRestartTiming({ ...input, handedOffAt })),
        Effect.flatMap((text) =>
          fileSystem
            .makeDirectory(runtimeDir, { recursive: true })
            .pipe(Effect.andThen(fileSystem.writeFileString(timingPath, text))),
        ),
        Effect.ignore,
      ),
    report: Effect.gen(function* () {
      const shownAt = yield* Deferred.await(windowShownAt);
      const backendAt = yield* Ref.get(backendReadyAt);
      return {
        version: 1,
        type: "desktopFeatureUsage",
        feature: "desktop-launch",
        action: "launched",
        platform: reportedPlatform(environment.platform),
        backendReadyMs: Option.match(backendAt, { onNone: () => null, onSome: sinceStart }),
        windowShownMs: sinceStart(shownAt),
        ...Option.match(previousRestart, {
          onNone: () => ({}),
          onSome: (restart) => ({
            update: {
              stopMs: Math.max(0, Math.round(restart.handedOffAt - restart.requestedAt)),
              relaunchMs: Math.max(0, Math.round(processStartedAt - restart.handedOffAt)),
              stagedInBackground: restart.stagedInBackground,
            },
          }),
        }),
      } satisfies DesktopLaunchTimingReport;
    }),
  });
});

export const layer = Layer.effect(DesktopLaunchTiming, make());

/** Sends this launch's timing through the backend telemetry pipe once the
    main window has been shown. */
export const layerReporter = Layer.effectDiscard(
  Effect.gen(function* () {
    const timing = yield* DesktopLaunchTiming;
    const telemetry = yield* DesktopTelemetryPublisher.DesktopTelemetryPublisher;
    yield* timing.report.pipe(
      Effect.tap((report) => logInfo("launch timing", { ...report })),
      Effect.flatMap(telemetry.publishFeatureUsage),
      Effect.forkScoped,
    );
  }),
);

/** For tests of services that mark milestones: records nothing. */
export const layerNoop = Layer.succeed(
  DesktopLaunchTiming,
  DesktopLaunchTiming.of({
    markBackendReady: Effect.void,
    markWindowShown: Effect.void,
    recordUpdateRestart: () => Effect.void,
    report: Effect.never,
  }),
);
