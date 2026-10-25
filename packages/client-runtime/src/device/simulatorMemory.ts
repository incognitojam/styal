import type { SimulatorMemoryState } from "@t3tools/contracts";

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
