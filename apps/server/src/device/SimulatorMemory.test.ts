import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { DeviceHostReady } from "./DeviceHost.ts";
import { configureSimulatorMemory, readSimulatorMemory } from "./SimulatorMemory.ts";

const features = [
  { id: "push", name: "Push notifications", labels: ["com.apple.apsd"] },
  { id: "storekit", name: "Purchases", labels: ["com.apple.storekitd", "com.apple.passd"] },
  { id: "widgets", name: "Widgets", labels: ["com.apple.chronod"] },
];

function simulator(
  options: {
    installed?: boolean;
    persistent?: boolean;
    failMutation?: boolean;
    failRead?: boolean;
  } = {},
) {
  let installed = options.installed ?? true;
  let disabled = new Set<string>();
  const mutations: string[][] = [];
  let installs = 0;
  const ready: DeviceHostReady = {
    nodePath: "/node",
    hub: { origin: "http://device.test" },
    helpers: { serveSimAxSettings: null, serveSimCli: null },
    run: (command, args) =>
      Effect.sync(() => {
        const json = (value: unknown, code = 0) => ({
          code,
          stdout: JSON.stringify(value),
          stderr: "",
        });
        if (command === "/node") {
          if (args.at(-1) === "install") {
            installed = true;
            installs++;
          }
          return json({ supported: true, installed, executable: "/tools/simslim" });
        }
        if (args[0] === "doctor" && args.includes("--list")) return json(features);
        if (args[0] === "status") {
          if (options.failRead) return { code: 0, stdout: "not JSON", stderr: "" };
          return json({
            managedDisabled: disabled.size,
            persistent: options.persistent ?? true,
            dropped: [],
          });
        }
        if (args[0] === "doctor") {
          const requested = args[args.indexOf("--requires") + 1]!.split(",");
          const statuses = features
            .filter((feature) => requested.includes(feature.id))
            .map((feature) => ({
              id: feature.id,
              name: feature.name,
              ok: feature.labels.every((label) => !disabled.has(label)),
            }));
          return json({ features: statuses }, statuses.some((feature) => !feature.ok) ? 1 : 0);
        }
        if (args[0] === "on" || args[0] === "off") {
          mutations.push([...args]);
          if (options.failMutation) return { code: 1, stdout: "", stderr: "test failure" };
          const keepIndex = args.indexOf("--keep");
          const keep = new Set(keepIndex < 0 ? [] : args[keepIndex + 1]!.split(","));
          disabled = new Set(
            args[0] === "off"
              ? []
              : features.flatMap((feature) => feature.labels).filter((label) => !keep.has(label)),
          );
          return { code: 0, stdout: "Done", stderr: "" };
        }
        throw new Error(`Unexpected host command: ${command} ${args.join(" ")}`);
      }),
  };
  return { ready, mutations, installs: () => installs };
}

describe("simulator memory profiles", () => {
  it.effect("inspects without installing or changing simulator services", () =>
    Effect.gen(function* () {
      const sim = simulator({ installed: false });
      expect(yield* readSimulatorMemory(sim.ready, "SIM-1")).toMatchObject({
        supported: true,
        installed: false,
        mode: "unknown",
      });
      expect(sim.installs()).toBe(0);
      expect(sim.mutations).toEqual([]);
      yield* configureSimulatorMemory(sim.ready, {
        type: "prepareSimulatorMemory",
        deviceId: "SIM-1",
      });
      expect(yield* readSimulatorMemory(sim.ready, "SIM-1")).toMatchObject({
        installed: true,
        mode: "standard",
      });
      expect(sim.mutations).toEqual([]);
    }),
  );

  it.effect("keeps every service for required capabilities and restores standard services", () =>
    Effect.gen(function* () {
      const sim = simulator();
      yield* configureSimulatorMemory(sim.ready, {
        type: "setMemoryProfile",
        deviceId: "SIM-1",
        mode: "low-memory",
        keepCapabilities: ["push", "storekit"],
      });
      const slim = yield* readSimulatorMemory(sim.ready, "SIM-1");
      expect(slim.mode).toBe("low-memory");
      expect(slim.disabledServices).toBe(1);
      expect(slim.capabilities).toEqual([
        { id: "push", name: "Push notifications", enabled: true },
        { id: "storekit", name: "Purchases", enabled: true },
        { id: "widgets", name: "Widgets", enabled: false },
      ]);
      yield* configureSimulatorMemory(sim.ready, {
        type: "setMemoryProfile",
        deviceId: "SIM-1",
        mode: "standard",
      });
      const stock = yield* readSimulatorMemory(sim.ready, "SIM-1");
      expect(stock.mode).toBe("standard");
      expect(stock.capabilities.every((feature) => feature.enabled)).toBe(true);
      expect(sim.mutations.every((args) => args[1] === "SIM-1")).toBe(true);
    }),
  );

  it.effect("rejects unknown capabilities before changing the device", () =>
    Effect.gen(function* () {
      const sim = simulator();
      const error = yield* Effect.flip(
        configureSimulatorMemory(sim.ready, {
          type: "setMemoryProfile",
          deviceId: "SIM-1",
          mode: "low-memory",
          keepCapabilities: ["typo"],
        }),
      );
      expect(error._tag).toBe("DeviceOperationError");
      expect(sim.mutations).toEqual([]);
    }),
  );

  it.effect("refuses persistent slimming on an older runtime but allows restoration", () =>
    Effect.gen(function* () {
      const sim = simulator({ persistent: false });
      const error = yield* Effect.flip(
        configureSimulatorMemory(sim.ready, {
          type: "setMemoryProfile",
          deviceId: "SIM-1",
          mode: "low-memory",
          keepCapabilities: [],
        }),
      );
      expect(error.message).toContain("iOS 18.5");
      expect(sim.mutations).toEqual([]);
      yield* configureSimulatorMemory(sim.ready, {
        type: "setMemoryProfile",
        deviceId: "SIM-1",
        mode: "standard",
      });
      expect(sim.mutations).toHaveLength(1);
    }),
  );

  it.effect(
    "reports failed commands and malformed state instead of claiming a profile applied",
    () =>
      Effect.gen(function* () {
        const failed = simulator({ failMutation: true });
        expect(
          (yield* Effect.flip(
            configureSimulatorMemory(failed.ready, {
              type: "setMemoryProfile",
              deviceId: "SIM-1",
              mode: "low-memory",
              keepCapabilities: [],
            }),
          ))._tag,
        ).toBe("DeviceOperationError");
        const invalid = simulator({ failRead: true });
        expect((yield* Effect.flip(readSimulatorMemory(invalid.ready, "SIM-1")))._tag).toBe(
          "DeviceOperationError",
        );
      }),
  );
});
