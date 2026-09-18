import type { ProviderInstanceEnvironment } from "@t3tools/contracts";

import { expandHomePath } from "../pathExpansion.ts";
import { stripServerOwnedEnvironment } from "../serverOwnedEnvironment.ts";
import { T3CODE_CODEX_LAUNCH_ARGS_ENV } from "./Layers/codexLaunchArgs.ts";

/**
 * The server's environment without its own settings, used as the base for
 * provider processes. Agents can start other styal servers, which must not
 * inherit this server's settings. `T3CODE_CODEX_LAUNCH_ARGS` is kept because
 * the Codex adapter reads it from this environment.
 */
export function inheritedProviderEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return stripServerOwnedEnvironment(env, [T3CODE_CODEX_LAUNCH_ARGS_ENV]);
}

/**
 * Applies a provider instance's configured variables on top of `baseEnv`. An
 * explicit `baseEnv` is used as given; only the default is filtered.
 */
export function mergeProviderInstanceEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = inheritedProviderEnvironment(),
): NodeJS.ProcessEnv {
  if (!environment || environment.length === 0) {
    return baseEnv;
  }

  const next: NodeJS.ProcessEnv = { ...baseEnv };
  for (const variable of environment) {
    // Child processes do not apply shell expansion to environment values.
    next[variable.name] =
      variable.name === "CODEX_HOME" || variable.name === "CLAUDE_CONFIG_DIR"
        ? expandHomePath(variable.value)
        : variable.value;
  }
  return next;
}
