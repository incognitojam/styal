import {
  FORK_CLIENT_USAGE_VERSION,
  type EnvironmentId,
  type ForkClientUsageInput,
} from "@t3tools/contracts";

import { appAtomRegistry } from "./atom-registry";
import { serverEnvironment } from "./server";

/** Best-effort reporting through the owning environment; servers without the vocabulary are skipped. */
export function reportForkClientUsage(
  environmentId: EnvironmentId | null | undefined,
  input: ForkClientUsageInput,
) {
  try {
    if (!environmentId) return;
    const config = appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId));
    if ((config?.environment.capabilities.forkClientUsageVersion ?? 0) < FORK_CLIENT_USAGE_VERSION)
      return;
    void serverEnvironment.reportForkClientUsage
      .run(appAtomRegistry, { environmentId, input })
      .catch(() => undefined);
  } catch {
    // A disconnected or older server must never affect the interaction.
  }
}
