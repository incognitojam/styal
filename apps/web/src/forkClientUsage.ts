import type { EnvironmentId, ForkClientUsageInput } from "@t3tools/contracts";

import { appAtomRegistry } from "./rpc/atomRegistry";
import { serverEnvironment } from "./state/server";

/** Best-effort reporting through the environment that owns the interaction. */
export async function reportForkClientUsage(
  environmentId: EnvironmentId | null | undefined,
  input: ForkClientUsageInput,
): Promise<void> {
  try {
    if (!environmentId) return;
    const config = appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId));
    if (config?.environment.capabilities.forkClientUsage !== true) return;
    await serverEnvironment.reportForkClientUsage.run(appAtomRegistry, { environmentId, input });
  } catch {
    // A disconnected or older server must never affect the interaction.
  }
}
