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
// Matches the device hub's own boot limit; SimSlim's default is ten minutes.
const SIMSLIM_BOOT_TIMEOUT = "3m";
const SIMSLIM_TIMEOUT_MS = 200_000;
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

// SimSlim only persists overrides from iOS 18.5.
const supportsPersistentOverrides = (version: string) => {
  const match = /(\d+)(?:\.(\d+))?/.exec(version);
  if (!match) return true;
  const major = Number(match[1]);
  return major > 18 || (major === 18 && Number(match[2] ?? 0) >= 5);
};

/** What startup did with the memory mode; bounded so telemetry can report it. */
export type SimulatorMemoryResult =
  | "applied"
  | "unchanged"
  | "fallback_runtime"
  | "fallback_host"
  | "fallback_helper"
  | "fallback_check";

const STANDARD_FALLBACK = "The simulator started with standard memory.";
const NOTICES: Partial<Record<SimulatorMemoryResult, string>> = {
  fallback_runtime: `Low memory needs iOS 18.5 or newer. ${STANDARD_FALLBACK}`,
  fallback_host: `Low memory needs an Apple Silicon Mac. ${STANDARD_FALLBACK}`,
  fallback_helper: `Could not install the low memory helper. ${STANDARD_FALLBACK}`,
  fallback_check:
    "Could not check the simulator memory helper. The simulator started with its current memory mode.",
};
export const simulatorMemoryNotice = (result: SimulatorMemoryResult) => NOTICES[result];

/**
 * Runs before boot/stream attachment, under the owning host's device lock.
 * Low memory saves RAM but nothing depends on it, so a host or runtime that
 * cannot use it starts normally and returns a fallback result instead of failing.
 */
export const prepareSimulatorMemory = Effect.fn("SimulatorMemory.prepare")(function* (
  ready: DeviceHostReady,
  device: { readonly id: string; readonly version: string },
  mode: SimulatorMemoryMode,
  options?: {
    readonly stillStopped: Effect.Effect<boolean, DeviceError>;
    readonly onMutationStart?: Effect.Effect<void>;
    readonly onMutationError: Effect.Effect<void>;
  },
) {
  if (mode === "low-memory" && !supportsPersistentOverrides(device.version))
    return "fallback_runtime" as const;
  const helper = yield* command(
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
  ).pipe(
    Effect.flatMap((output) => decode(Helper, output)),
    Effect.catch((cause) =>
      Effect.logWarning("Could not prepare the simulator memory helper", { cause }).pipe(
        Effect.as(null),
      ),
    ),
  );
  if (!helper)
    return mode === "low-memory" ? ("fallback_helper" as const) : ("fallback_check" as const);
  if (!helper.supported || !helper.installed) {
    // Standard must not install a helper on a stock simulator host.
    if (mode === "standard") return "unchanged" as const;
    return helper.supported ? ("fallback_helper" as const) : ("fallback_host" as const);
  }
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
  if (!(yield* options?.stillStopped ?? Effect.succeed(true))) return "unchanged" as const;
  yield* options?.onMutationStart ?? Effect.void;
  yield* Effect.gen(function* () {
    yield* command(
      ready,
      helper.executable,
      [
        "--boot-timeout",
        SIMSLIM_BOOT_TIMEOUT,
        ...(mode === "standard"
          ? ["off", device.id]
          : ["on", device.id, "--keep", labels.join(",")]),
      ],
      // SimSlim's own limit covers the offline rewrite and the boot.
      SIMSLIM_TIMEOUT_MS,
    );
    const actual = yield* decode(
      Status,
      yield* command(ready, helper.executable, ["status", device.id, "--json"]),
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
          device.id,
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
  return "applied" as const;
});
