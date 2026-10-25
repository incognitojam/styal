import {
  DeviceOperationError,
  type DeviceError,
  type SimulatorMemoryMode,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { DeviceHostReady } from "./DeviceHost.ts";
import { simslimHostScript } from "./simslimHostScript.ts";

const KEEP_CAPABILITIES = [
  "push",
  "storekit",
  "universal-links",
  "icloud",
  "keychain-sync",
  "photos",
  "contacts",
  "calendar",
];
const Helper = Schema.Struct({
  supported: Schema.Boolean,
  installed: Schema.Boolean,
  executable: Schema.String,
});
const Status = Schema.Struct({
  persistent: Schema.Boolean,
  managedDisabled: Schema.optional(Schema.Int),
});
const Features = Schema.Array(
  Schema.Struct({ id: Schema.String, labels: Schema.Array(Schema.String) }),
);
const Doctor = Schema.Struct({
  features: Schema.Array(Schema.Struct({ id: Schema.String, ok: Schema.Boolean })),
});

const command = Effect.fn("SimulatorMemory.command")(function* (
  ready: DeviceHostReady,
  executable: string,
  args: ReadonlyArray<string>,
  timeoutMs = 20_000,
) {
  const result = yield* ready.run(executable, args, { timeoutMs });
  if (result.code !== 0)
    return yield* new DeviceOperationError({
      operation: "prepare simulator memory",
      reason: "command_failed",
      exitCode: result.code,
      cause: result,
    });
  return result.stdout;
});

const decode = <S extends Schema.Top>(schema: S, output: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(output).pipe(
    Effect.mapError(
      (cause) =>
        new DeviceOperationError({
          operation: "prepare simulator memory",
          reason: "settings_failed",
          cause,
        }),
    ),
  );

/** Runs before boot/stream attachment, under the owning host's device lock. */
export const prepareSimulatorMemory = Effect.fn("SimulatorMemory.prepare")(function* (
  ready: DeviceHostReady,
  deviceId: string,
  mode: SimulatorMemoryMode,
  options?: {
    readonly stillStopped: Effect.Effect<boolean, DeviceError>;
    readonly onMutationStart?: Effect.Effect<void>;
    readonly onMutationError: Effect.Effect<void>;
  },
) {
  const helper = yield* decode(
    Helper,
    yield* command(
      ready,
      ready.nodePath,
      [
        "--input-type=module",
        "--eval",
        simslimHostScript,
        "--",
        mode === "low-memory" ? "install" : "probe",
      ],
      120_000,
    ),
  );
  // Standard must not install a helper on a stock simulator host.
  if (mode === "standard" && (!helper.supported || !helper.installed)) return;
  if (!helper.supported || !helper.installed)
    return yield* new DeviceOperationError({
      operation: "prepare simulator memory",
      reason: "unsupported_runtime",
      cause: new Error("Low memory requires an Apple Silicon Mac."),
    });
  let labels: ReadonlyArray<string> = [];
  if (mode === "low-memory") {
    const features = yield* decode(
      Features,
      yield* command(ready, helper.executable, ["doctor", "--list", "--json"]),
    );
    if (!KEEP_CAPABILITIES.every((id) => features.some((feature) => feature.id === id)))
      return yield* new DeviceOperationError({
        operation: "prepare simulator memory",
        reason: "settings_failed",
        cause: new Error("The simulator helper does not support the required preset."),
      });
    labels = [
      ...new Set(
        features
          .filter((feature) => KEEP_CAPABILITIES.includes(feature.id))
          .flatMap((feature) => feature.labels),
      ),
    ];
  }
  // SimSlim prepares and boots a stopped device itself. There is no viewer yet.
  // Setup can take long enough for an external tool to boot the simulator.
  if (!(yield* options?.stillStopped ?? Effect.succeed(true))) return;
  yield* options?.onMutationStart ?? Effect.void;
  yield* Effect.gen(function* () {
    yield* command(
      ready,
      helper.executable,
      mode === "standard" ? ["off", deviceId] : ["on", deviceId, "--keep", labels.join(",")],
      660_000,
    );
    const actual = yield* decode(
      Status,
      yield* command(ready, helper.executable, ["status", deviceId, "--json"]),
    );
    if (
      actual.managedDisabled === undefined ||
      (mode === "standard"
        ? actual.managedDisabled !== 0
        : actual.managedDisabled <= 0 || !actual.persistent)
    )
      return yield* new DeviceOperationError({
        operation: "prepare simulator memory",
        reason: "settings_failed",
        cause: new Error("The simulator did not apply the requested memory mode."),
      });
    if (mode === "low-memory") {
      const doctor = yield* decode(
        Doctor,
        yield* command(ready, helper.executable, [
          "doctor",
          deviceId,
          "--requires",
          KEEP_CAPABILITIES.join(","),
          "--json",
        ]),
      );
      if (
        !KEEP_CAPABILITIES.every((id) =>
          doctor.features.some((feature) => feature.id === id && feature.ok),
        )
      )
        return yield* new DeviceOperationError({
          operation: "prepare simulator memory",
          reason: "settings_failed",
          cause: new Error("Required simulator capabilities are unavailable."),
        });
    }
  }).pipe(Effect.onError(() => options?.onMutationError ?? Effect.void));
});
