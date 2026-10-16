import {
  FORK_CLIENT_USAGE_VERSION,
  type EnvironmentId,
  type ForkClientUsageInput,
} from "@t3tools/contracts";

import { appAtomRegistry } from "./rpc/atomRegistry";
import { serverEnvironment } from "./state/server";

/** Best-effort reporting through the owning environment; unsupported vocabularies return nothing. */
export function reportForkClientUsage(
  environmentId: EnvironmentId | null | undefined,
  input: ForkClientUsageInput,
) {
  try {
    if (!environmentId) return;
    const config = appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId));
    if ((config?.environment.capabilities.forkClientUsageVersion ?? 0) < FORK_CLIENT_USAGE_VERSION)
      return;
    return serverEnvironment.reportForkClientUsage
      .run(appAtomRegistry, { environmentId, input })
      .catch(() => {});
  } catch {
    // A disconnected or older server must never affect the interaction.
  }
}
