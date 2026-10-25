import type { ProviderInstanceEnvironment } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { expandHomePath } from "./pathExpansion.ts";
import { stripServerOwnedEnvironment } from "@t3tools/shared/serverOwnedEnvironment";

/** Read by the Codex adapter from the provider environment, so it must survive stripping. */
const CODEX_LAUNCH_ARGS_ENV = "T3CODE_CODEX_LAUNCH_ARGS";

/**
 * The server's environment without its own settings, used as the base for
 * provider processes. Agents can start other styal servers, which must not
 * inherit this server's settings.
 */
export function inheritedProviderEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return stripServerOwnedEnvironment(env, [CODEX_LAUNCH_ARGS_ENV]);
}

/**
 * Applies a provider instance's configured variables on top of `baseEnv`. An
 * explicit `baseEnv` is used as given; the default is the host environment
 * filtered by `inheritedProviderEnvironment`.
 */
export const mergeProviderInstanceEnvironment = Effect.fn(function* (
  environment: ProviderInstanceEnvironment | undefined,
  explicitBaseEnv?: NodeJS.ProcessEnv,
) {
  const baseEnv = explicitBaseEnv ?? inheritedProviderEnvironment(yield* HostProcess.Environment);
  if (!environment || environment.length === 0) {
    return baseEnv;
  }

  const home = yield* HostProcess.HomeDirectory;
  const next: NodeJS.ProcessEnv = { ...baseEnv };
  for (const variable of environment) {
    next[variable.name] =
      variable.name === "CODEX_HOME" || variable.name === "CLAUDE_CONFIG_DIR"
        ? expandHomePath(variable.value, home)
        : variable.value;
  }
  return next;
});
