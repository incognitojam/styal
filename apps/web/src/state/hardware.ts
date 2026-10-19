import { createHardwareEnvironmentAtoms } from "@t3tools/client-runtime/state/hardware";
import type { EnvironmentId, HardwareServiceState } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";

export const hardwareEnvironment = createHardwareEnvironmentAtoms(connectionAtomRuntime);

const EMPTY_HARDWARE_STATE: HardwareServiceState = { devices: [] };

/**
 * Live hardware state for one environment. Pass `probeHealth` only from
 * surfaces that show device health: the server probes every device while any
 * such subscriber is mounted. Pass null when there is nothing to show.
 */
export function useHardwareState(
  environmentId: EnvironmentId | null,
  options: { readonly probeHealth: boolean },
): {
  readonly state: HardwareServiceState;
  readonly loaded: boolean;
  readonly error: string | null;
} {
  const query = useEnvironmentQuery(
    environmentId === null
      ? null
      : hardwareEnvironment.state({
          environmentId,
          input: { probeHealth: options.probeHealth },
        }),
  );
  return {
    state: query.data ?? EMPTY_HARDWARE_STATE,
    loaded: query.data !== null,
    error: query.error,
  };
}
