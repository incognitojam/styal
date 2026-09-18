import type { ProviderInstanceEnvironment } from "@t3tools/contracts";

import { expandHomePath } from "../pathExpansion.ts";
import { stripServerOwnedEnvironment } from "../serverOwnedEnvironment.ts";
import { T3CODE_CODEX_LAUNCH_ARGS_ENV } from "./Layers/codexLaunchArgs.ts";

/**
 * What a provider process inherits from the server. Agents run arbitrary
 * commands, including `vp run dev` and other styal servers, so the server's
 * own settings stay behind. The Codex launch args override is read back out of
 * this environment by the Codex adapter, so it passes through.
 */
export function inheritedProviderEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return stripServerOwnedEnvironment(env, [T3CODE_CODEX_LAUNCH_ARGS_ENV]);
}

/**
 * Layers a provider instance's configured variables over `baseEnv`. A caller
 * that passes its own `baseEnv` owns its contents; nothing is stripped from it.
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
