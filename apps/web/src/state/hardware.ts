import { createHardwareEnvironmentAtoms } from "@t3tools/client-runtime/state/hardware";
import type { EnvironmentId, HardwareServiceState } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";

export const hardwareEnvironment = createHardwareEnvironmentAtoms(connectionAtomRuntime);

const EMPTY_HARDWARE_STATE: HardwareServiceState = { devices: [] };

/**
 * Live hardware state for one environment. Mounting this subscribes and makes
 * the server probe device health, so only hardware surfaces call it, and pass
 * null when they have nothing to show.
 */
export function useHardwareState(environmentId: EnvironmentId | null): {
  readonly state: HardwareServiceState;
  readonly loaded: boolean;
  readonly error: string | null;
} {
  const query = useEnvironmentQuery(
    environmentId === null ? null : hardwareEnvironment.state({ environmentId, input: {} }),
  );
  return {
    state: query.data ?? EMPTY_HARDWARE_STATE,
    loaded: query.data !== null,
    error: query.error,
  };
}
