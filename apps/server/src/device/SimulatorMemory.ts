import {
  DeviceOperationError,
  type SimulatorMemoryState,
  type DeviceActionInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { DeviceHostReady } from "./DeviceHost.ts";
import { simslimHostScript } from "./simslimHostScript.ts";

const HostHelper = Schema.Struct({
  supported: Schema.Boolean,
  installed: Schema.Boolean,
  executable: Schema.String,
});
const Feature = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  labels: Schema.Array(Schema.String),
});
const Status = Schema.Struct({
  managedDisabled: Schema.Int,
  persistent: Schema.Boolean,
});
const Doctor = Schema.Struct({
  features: Schema.Array(
    Schema.Struct({ id: Schema.String, name: Schema.String, ok: Schema.Boolean }),
  ),
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
      operation: "simulator memory profile",
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
          operation: "simulator memory profile",
          reason: "settings_failed",
          cause,
        }),
    ),
  );

const helper = Effect.fn("SimulatorMemory.helper")(function* (
  ready: DeviceHostReady,
  install: boolean,
) {
  return yield* decode(
    HostHelper,
    yield* command(
      ready,
      ready.nodePath,
      ["--input-type=module", "--eval", simslimHostScript, "--", install ? "install" : "probe"],
      120_000,
    ),
  );
});

export const readSimulatorMemory = Effect.fn("SimulatorMemory.read")(function* (
  ready: DeviceHostReady,
  deviceId: string,
): Effect.fn.Return<SimulatorMemoryState, DeviceOperationError> {
  const tool = yield* helper(ready, false);
  if (!tool.supported || !tool.installed)
    return {
      supported: tool.supported,
      installed: tool.installed,
      mode: "unknown",
      capabilities: [],
    };
  const features = yield* decode(
    Schema.Array(Feature),
    yield* command(ready, tool.executable, ["doctor", "--list", "--json"]),
  );
  const status = yield* decode(
    Status,
    yield* command(ready, tool.executable, ["status", deviceId, "--json"]),
  );
  // doctor exits non-zero when a feature is disabled; its JSON is still the authoritative result.
  const diagnosis = yield* ready.run(tool.executable, [
    "doctor",
    deviceId,
    "--requires",
    features.map((feature) => feature.id).join(","),
    "--json",
  ]);
  const doctor = yield* decode(Doctor, diagnosis.stdout);
  return {
    supported: true,
    installed: true,
    mode: status.managedDisabled === 0 ? "standard" : "low-memory",
    disabledServices: status.managedDisabled,
    persistent: status.persistent,
    capabilities: doctor.features.map((feature) => ({
      id: feature.id,
      name: feature.name,
      enabled: feature.ok,
    })),
  };
});

export const configureSimulatorMemory = Effect.fn("SimulatorMemory.configure")(function* <
  E = never,
>(
  ready: DeviceHostReady,
  input: Extract<DeviceActionInput, { type: "prepareSimulatorMemory" | "setMemoryProfile" }>,
  aroundApply: (
    operation: Effect.Effect<string, DeviceOperationError>,
  ) => Effect.Effect<string, DeviceOperationError | E> = (operation) => operation,
) {
  const tool = yield* helper(ready, true);
  if (!tool.supported)
    return yield* new DeviceOperationError({
      operation: "simulator memory profile",
      reason: "settings_failed",
      cause: new Error("SimSlim requires an Apple Silicon Mac."),
    });
  if (input.type === "prepareSimulatorMemory") return;
  const status = yield* decode(
    Status,
    yield* command(ready, tool.executable, ["status", input.deviceId, "--json"]),
  );
  if (input.mode === "low-memory" && !status.persistent)
    return yield* new DeviceOperationError({
      operation: "simulator memory profile",
      reason: "unsupported_runtime",
      cause: new Error("Persistent launchd overrides are not supported by this runtime."),
    });
  const features = yield* decode(
    Schema.Array(Feature),
    yield* command(ready, tool.executable, ["doctor", "--list", "--json"]),
  );
  const requested = input.mode === "standard" ? [] : input.keepCapabilities;
  const kept = features.filter((feature) => requested.includes(feature.id));
  if (requested.some((id) => !features.some((feature) => feature.id === id)))
    return yield* new DeviceOperationError({
      operation: "simulator memory profile",
      reason: "invalid_payload",
      cause: new Error("Unknown simulator capability."),
    });
  const labels = [...new Set(kept.flatMap((feature) => feature.labels))];
  yield* aroundApply(
    command(
      ready,
      tool.executable,
      input.mode === "standard"
        ? ["off", input.deviceId]
        : ["on", input.deviceId, ...(labels.length > 0 ? ["--keep", labels.join(",")] : [])],
      660_000,
    ),
  );
  if (requested.length > 0)
    yield* command(ready, tool.executable, [
      "doctor",
      input.deviceId,
      "--requires",
      requested.join(","),
      "--json",
    ]);
});
