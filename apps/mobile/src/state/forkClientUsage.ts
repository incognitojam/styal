import {
  FORK_CLIENT_USAGE_VERSION,
  type EnvironmentId,
  type ForkClientUsageInput,
  type ServerConfig,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import { appAtomRegistry } from "./atom-registry";
import { serverEnvironment } from "./server";

/** Whether the server accepts this client's usage vocabulary. */
export function supportsForkClientUsage(
  config: Pick<ServerConfig, "environment"> | null | undefined,
) {
  return (
    (config?.environment.capabilities.forkClientUsageVersion ?? 0) >= FORK_CLIENT_USAGE_VERSION
  );
}

/**
 * Best-effort reporting through the owning environment. Returns nothing when the server does not
 * support the report; otherwise resolves to whether the server received it.
 */
export function reportForkClientUsage(
  environmentId: EnvironmentId | null | undefined,
  input: ForkClientUsageInput,
) {
  try {
    if (!environmentId) return;
    if (
      !supportsForkClientUsage(
        appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId)),
      )
    )
      return;
    return serverEnvironment.reportForkClientUsage
      .run(appAtomRegistry, { environmentId, input })
      .then(AsyncResult.isSuccess, () => false);
  } catch {
    // A disconnected or older server must never affect the interaction.
  }
}
