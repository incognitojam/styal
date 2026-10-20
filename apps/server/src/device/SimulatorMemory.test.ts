import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { DeviceHostReady } from "./DeviceHost.ts";
import { prepareSimulatorMemory, simulatorMemoryNotice } from "./SimulatorMemory.ts";

const capabilities = [
  "push",
  "storekit",
  "universal-links",
  "icloud",
  "keychain-sync",
  "photos",
  "contacts",
  "calendar",
];
const simulator = { id: "simulator", version: "26.5" };
const fixture = (installed = true, supported = true) => {
  const calls: { command: string; args: readonly string[] }[] = [];
  const state = {
    installed,
    disabled: 153,
    mutationCode: 0,
    doctorCode: 0,
    doctor: JSON.stringify({ features: capabilities.map((id) => ({ id, ok: true })) }),
    applyChanges: true,
    installFails: false,
  };
  const ready: DeviceHostReady = {
devices: {
      list: Effect.die("Typed environment operations are required"),
      boot: () => Effect.die("Typed environment operations are required"),
      attach: () => Effect.die("Typed environment operations are required"),
      shutdown: () => Effect.die("Typed environment operations are required"),
      screenshot: () => Effect.die("Typed environment operations are required"),
    },
    nodePath: "/node",
    hub: { origin: "http://simulator.test" },
    helpers: { serveSimCli: null, serveSimAxSettings: null },
    run: (command, args) =>
      Effect.sync(() => {
        calls.push({ command, args });
        const json = (value: unknown) => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });
        if (command === "/node") {
          if (state.installFails) return { code: 1, stdout: "", stderr: "download failed" };
          if (supported && args.at(-1) === "install") state.installed = true;
          return json({ supported, installed: state.installed, executable: "/simslim" });
        }
        if (args[0] === "--boot-timeout") args = args.slice(2);
        if (args[0] === "status")
          return json({ persistent: true, managedDisabled: state.disabled });
        if (args.includes("--list"))
          return json(capabilities.map((id) => ({ id, labels: [`com.apple.test.${id}`] })));
        if (args[0] === "doctor")
          return { code: state.doctorCode, stdout: state.doctor, stderr: "" };
        if (state.mutationCode === 0 && state.applyChanges)
          state.disabled = args[0] === "off" ? 0 : 153;
        return { code: state.mutationCode, stdout: "", stderr: "" };
      }),
  };
  return { ready, state, calls };
};

it.effect("leaves stock Standard hosts untouched without installing a helper", () =>
  Effect.gen(function* () {
    const f = fixture(false);
    yield* prepareSimulatorMemory(f.ready, simulator, "standard");
    expect(f.state.installed).toBe(false);
    expect(f.calls.map((call) => call.args.at(-1))).toEqual(["probe"]);
  }),
);

it.effect("preserves the fixed capabilities, checks readback, and restores Standard", () =>
  Effect.gen(function* () {
    const f = fixture(false);
    yield* prepareSimulatorMemory(f.ready, simulator, "low-memory");
    const apply = f.calls.find((call) => call.args.includes("on"))!;
    expect(apply.args).toEqual([
      "--boot-timeout",
      "3m",
      "on",
      "simulator",
      "--keep",
      capabilities.map((id) => `com.apple.test.${id}`).join(","),
    ]);
    expect(f.calls.at(-1)?.args).toEqual([
      "doctor",
      "simulator",
      "--requires",
      capabilities.join(","),
      "--json",
    ]);
    yield* prepareSimulatorMemory(f.ready, simulator, "standard");
    expect(f.state.disabled).toBe(0);
    expect(f.calls.at(-1)?.args).toEqual(["status", "simulator", "--json"]);
  }),
);

it.effect.each(["standard", "low-memory"] as const)("refuses a timed-out %s command", (mode) =>
  Effect.gen(function* () {
    const f = fixture();
    f.state.mutationCode = 124;
    const error = yield* prepareSimulatorMemory(f.ready, simulator, mode).pipe(Effect.flip);
    expect(error).toMatchObject({
      _tag: "DeviceOperationError",
      reason: "command_failed",
      exitCode: 124,
    });
  }),
);

it.effect.each([
  "",
  "invalid JSON",
  JSON.stringify({ features: [] }),
  JSON.stringify({ features: capabilities.map((id) => ({ id, ok: id !== "icloud" })) }),
])("rejects incomplete required-capability verification (%s)", (doctor) =>
  Effect.gen(function* () {
    const f = fixture();
    f.state.doctor = doctor;
    const error = yield* prepareSimulatorMemory(f.ready, simulator, "low-memory").pipe(Effect.flip);
    expect(error).toMatchObject({ _tag: "DeviceOperationError", reason: "settings_failed" });
  }),
);

it.effect.each(["standard", "low-memory"] as const)(
  "rejects %s when actual services do not match",
  (mode) =>
    Effect.gen(function* () {
      const f = fixture();
      f.state.applyChanges = false;
      f.state.disabled = mode === "standard" ? 153 : 0;
      const error = yield* prepareSimulatorMemory(f.ready, simulator, mode).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "DeviceOperationError", reason: "settings_failed" });
    }),
);

it.effect("does not reconfigure a device booted or claimed during helper setup", () =>
  Effect.gen(function* () {
    const f = fixture(false);
    yield* prepareSimulatorMemory(f.ready, simulator, "low-memory", {
      stillStopped: Effect.succeed(false),
      onMutationError: Effect.void,
    });
    expect(f.calls.some((call) => call.args.includes("on") || call.args.includes("off"))).toBe(
      false,
    );
  }),
);

it.effect.each([
  ["an older runtime", { version: "18.4" }, "fallback_runtime", "iOS 18.5 or newer"],
  ["an Intel Mac", { supported: false }, "fallback_host", "Apple Silicon Mac"],
  ["a failed helper download", { installFails: true }, "fallback_helper", "install the low memory"],
] as const)("starts normally with a notice on %s", ([, setup, expected, notice]) =>
  Effect.gen(function* () {
    const f = fixture(false, !("supported" in setup));
    if ("installFails" in setup) f.state.installFails = true;
    const result = yield* prepareSimulatorMemory(
      f.ready,
      { ...simulator, ...("version" in setup ? { version: setup.version } : {}) },
      "low-memory",
    );
    expect(result).toBe(expected);
    expect(simulatorMemoryNotice(result)).toContain(notice);
    expect(f.calls.some((call) => call.args.includes("on") || call.args.includes("off"))).toBe(
      false,
    );
  }),
);
