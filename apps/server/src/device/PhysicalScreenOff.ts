/**
 * Keeps physical Android screens dark while styal has them open, so a phone
 * left plugged into an environment server is not lit for hours. Streaming and
 * input continue: the panel is powered off through scrcpy's display power
 * control, the same mechanism as `scrcpy --turn-screen-off`, while the display
 * keeps compositing for the hub's mirror.
 *
 * Each device gets its own control-only scrcpy server alongside the hub's.
 * scrcpy restores the display and the stay-awake setting when that server
 * exits, including when styal dies and its socket closes, so nothing here has
 * to undo device state.
 */
import * as NodeNet from "node:net";

import {
  type DeviceServiceState,
  LOCAL_DEVICE_HOST_ID,
  type ServerSettings as ServerSettingsValue,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Random from "effect/Random";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DeviceHost from "./DeviceHost.ts";

const DEVICE_JAR_PATH = "/data/local/tmp/styal-display-power-scrcpy-server.jar";
/** scrcpy's `TYPE_SET_DISPLAY_POWER` followed by `on = false`. */
const DISPLAY_POWER_OFF = Uint8Array.of(10, 0);
const RETRY_INTERVAL = Duration.seconds(15);

export interface DisplayPowerTools {
  readonly hostId: string;
  readonly adb: string;
  readonly env: Record<string, string | undefined>;
  /** scrcpy-server jar vendored by the device hub, and the version it reports. */
  readonly server: { readonly path: string; readonly version: string };
  readonly run: DeviceHost.DeviceHostReady["run"];
}

/** Finds the scrcpy-server the hub ships, named `scrcpy-server-v<version>`. */
export const scrcpyServerVersion = (fileName: string) =>
  /^scrcpy-server-v(\d+(?:\.\d+)*)$/.exec(fileName)?.[1] ?? null;

class ScrcpyControlError extends Schema.TaggedError<ScrcpyControlError>()("ScrcpyControlError", {
  reason: Schema.String,
}) {}

/**
 * Resolves once scrcpy's control socket answers. Before the device-side
 * socket exists, adb accepts the forwarded connection and closes it.
 */
const connectControl = (port: number) =>
  Effect.callback<NodeNet.Socket, ScrcpyControlError>((resume) => {
    const socket = NodeNet.connect(port, "127.0.0.1");
    const fail = (reason: string) => {
      socket.destroy();
      resume(Effect.fail(new ScrcpyControlError({ reason })));
    };
    socket.once("error", (error) => fail(error.message));
    socket.once("close", () => fail("scrcpy closed the control socket"));
    // `send_dummy_byte=true` makes the server write one byte once it accepts.
    socket.once("data", () => {
      socket.removeAllListeners();
      socket.on("error", () => {});
      resume(Effect.succeed(socket));
    });
    return Effect.sync(() => socket.destroy());
  }).pipe(
    Effect.timeout(Duration.seconds(2)),
    Effect.retry({ schedule: Schedule.spaced(Duration.millis(200)), times: 40 }),
  );

const untilClosed = (socket: NodeNet.Socket) =>
  Effect.callback<void>((resume) => {
    if (socket.destroyed) return resume(Effect.void);
    socket.once("close", () => resume(Effect.void));
  });

/**
 * Powers the display of the device with adb serial `serial` off and keeps it
 * off until the scope closes. Completes if the device disconnects.
 */
export const holdDisplayOff = Effect.fn("PhysicalScreenOff.holdDisplayOff")(function* (
  tools: DisplayPowerTools,
  serial: string,
): Effect.fn.Return<
  void,
  DeviceHost.DeviceHostError,
  Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
> {
  const failure = (step: string) => (cause: unknown) =>
    new DeviceHost.DeviceHostError({ hostId: tools.hostId, step, cause });
  const adb = (args: ReadonlyArray<string>, step: string) =>
    tools
      .run(tools.adb, ["-s", serial, ...args])
      .pipe(
        Effect.flatMap((result) =>
          result.code === 0
            ? Effect.succeed(result.stdout.trim())
            : Effect.fail(
                failure(step)(
                  new ScrcpyControlError({ reason: result.stderr.trim() || `exit ${result.code}` }),
                ),
              ),
        ),
      );

  yield* adb(["push", tools.server.path, DEVICE_JAR_PATH], "copying the display power helper");
  // scrcpy session ids are 31-bit hex.
  const scid = (yield* Random.nextIntBetween(1, 0x7fffffff)).toString(16).padStart(8, "0");
  const port = Number(
    yield* adb(
      ["forward", "tcp:0", `localabstract:scrcpy_${scid}`],
      "forwarding the display power socket",
    ),
  );
  yield* Effect.addFinalizer(() =>
    tools.run(tools.adb, ["-s", serial, "forward", "--remove", `tcp:${port}`]),
  );
  const server = yield* ChildProcessSpawner.ChildProcessSpawner.use((spawner) =>
    spawner.spawn(
      ChildProcess.make(
        tools.adb,
        [
          "-s",
          serial,
          "shell",
          `CLASSPATH=${DEVICE_JAR_PATH}`,
          "app_process",
          "/",
          "com.genymobile.scrcpy.Server",
          tools.server.version,
          `scid=${scid}`,
          "log_level=warn",
          "video=false",
          "audio=false",
          "control=true",
          "tunnel_forward=true",
          "send_dummy_byte=true",
          "send_device_meta=false",
          "clipboard_autosync=false",
          // Without it the device sleeps on its screen timeout and the mirror goes black.
          "stay_awake=true",
          "cleanup=true",
        ],
        { env: tools.env, extendEnv: false, stdin: "ignore", stdout: "ignore", stderr: "ignore" },
      ),
    ),
  ).pipe(Effect.mapError(failure("starting the display power helper")));
  const socket = yield* Effect.acquireRelease(
    connectControl(port).pipe(Effect.mapError(failure("connecting to the display power helper"))),
    (socket) => Effect.sync(() => socket.destroy()),
  );
  yield* Effect.sync(() => socket.write(DISPLAY_POWER_OFF));
  yield* Effect.raceFirst(untilClosed(socket), Effect.ignore(server.exitCode));
});

/** Local physical Android devices with at least one styal session. */
export const screenOffTargets = (
  settings: Pick<ServerSettingsValue, "enableDeviceSupport" | "keepPhysicalAndroidScreensOff">,
  state: Pick<DeviceServiceState, "devices" | "sessions">,
): ReadonlySet<string> => {
  if (!settings.enableDeviceSupport || !settings.keepPhysicalAndroidScreensOff) return new Set();
  const physical = new Set(
    state.devices
      .filter(
        (device) =>
          device.hostId === LOCAL_DEVICE_HOST_ID &&
          device.platform === "android" &&
          device.physical,
      )
      .map((device) => device.id),
  );
  return new Set(
    state.sessions
      .filter(
        (session) => session.hostId === LOCAL_DEVICE_HOST_ID && physical.has(session.deviceId),
      )
      .map((session) => session.deviceId),
  );
};

/**
 * Holds each target's display off until it stops being a target. A hold that
 * ends early, such as on a replug, is retried while the device stays a target.
 */
export const keepScreensOff = Effect.fn("PhysicalScreenOff.keepScreensOff")(function* (input: {
  readonly host: DeviceHost.DeviceHost["Service"];
  readonly settings: Stream.Stream<ServerSettingsValue>;
  readonly states: Stream.Stream<DeviceServiceState>;
}) {
  const holds = new Map<string, Fiber.Fiber<unknown, unknown>>();
  const hold = Effect.fn("PhysicalScreenOff.hold")(
    function* (serial: string) {
      const ready = yield* input.host.current;
      if (!ready?.holdDisplayOff) return yield* Effect.fail("device hub not running" as const);
      yield* Effect.scoped(ready.holdDisplayOff(serial));
      return yield* Effect.fail("device disconnected" as const);
    },
    (effect, serial) =>
      effect.pipe(
        Effect.tapError((cause) =>
          Effect.logDebug("Could not keep a physical Android screen off", { serial, cause }),
        ),
        Effect.retry(Schedule.spaced(RETRY_INTERVAL)),
      ),
  );
  const reconcile = Effect.fn("PhysicalScreenOff.reconcile")(function* (
    targets: ReadonlySet<string>,
  ) {
    for (const [serial, fiber] of holds) {
      if (targets.has(serial)) continue;
      holds.delete(serial);
      yield* Fiber.interrupt(fiber);
    }
    for (const serial of targets) {
      if (!holds.has(serial)) holds.set(serial, yield* Effect.forkChild(hold(serial)));
    }
  });
  yield* Stream.zipLatest(input.settings, input.states).pipe(
    Stream.map(([settings, state]) => screenOffTargets(settings, state)),
    Stream.runForEach(reconcile),
  );
});
