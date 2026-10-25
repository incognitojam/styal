import type { SimulatorMemoryState } from "@t3tools/contracts";

export const simulatorMemoryConfirmation = (mode: "standard" | "low-memory") =>
  mode === "standard"
    ? {
        title: "Restore standard services?",
        message:
          "This restarts the simulator and re-enables all SimSlim-managed services for every app on it. Standard services stay enabled on future boots.",
        confirmLabel: "Restart and restore",
      }
    : {
        title: "Apply low-memory profile?",
        message:
          "This restarts the simulator and affects every app on it. The profile carries across future boots. Use Restore standard services to remove it; erasing simulator data may leave it in place.",
        confirmLabel: "Restart and apply",
      };

const INITIAL_KEEP = new Set([
  "push",
  "storekit",
  "universal-links",
  "keychain-sync",
  "photos",
  "contacts",
  "calendar",
]);

export const simulatorMemorySelection = (memory: SimulatorMemoryState) =>
  memory.capabilities
    .filter((capability) =>
      memory.mode === "low-memory" ? capability.enabled : INITIAL_KEEP.has(capability.id),
    )
    .map((capability) => capability.id);
