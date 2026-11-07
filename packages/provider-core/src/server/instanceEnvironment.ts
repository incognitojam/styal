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
 * A read-only environment that reads through on every access. Desktop sends the login shell's PATH
 * after the server starts, so a copy made while building a driver can lack it until a restart.
 */
function liveEnvironment(
  keys: () => ReadonlyArray<string>,
  read: (name: string) => string | undefined,
): NodeJS.ProcessEnv {
  const value = (name: string | symbol) => (typeof name === "string" ? read(name) : undefined);
  return new Proxy<NodeJS.ProcessEnv>(
    {},
    {
      get: (target, name) => value(name) ?? Reflect.get(target, name),
      has: (target, name) => value(name) !== undefined || Reflect.has(target, name),
      ownKeys: () => [...keys()],
      getOwnPropertyDescriptor: (_, name) => {
        const current = value(name);
        return current === undefined
          ? undefined
          : { value: current, enumerable: true, configurable: true, writable: false };
      },
      set: () => false,
      deleteProperty: () => false,
      defineProperty: () => false,
    },
  );
}

/**
 * Applies a provider instance's configured variables on top of `baseEnv`. An
 * explicit `baseEnv` is used as given; the default is a live view of the host
 * environment filtered by `inheritedProviderEnvironment`.
 */
export const mergeProviderInstanceEnvironment = Effect.fn(function* (
  environment: ProviderInstanceEnvironment | undefined,
  explicitBaseEnv?: NodeJS.ProcessEnv,
) {
  const home = yield* HostProcess.HomeDirectory;
  const windows = (yield* HostProcess.Platform) === "win32";
  const overrides: Record<string, string> = {};
  for (const variable of environment ?? []) {
    // An unresolved secret reference carries no value; the registry resolves it for the provider.
    if (typeof variable.value !== "string") continue;
    // Windows reads names without regard to case, and a child gets the first spelling in sort
    // order. Upper case sorts first, so the configured value wins even where a spawn merges the
    // parent environment back in.
    const name = windows ? variable.name.toUpperCase() : variable.name;
    overrides[name] =
      name === "CODEX_HOME" || name === "CLAUDE_CONFIG_DIR"
        ? expandHomePath(variable.value, home)
        : variable.value;
  }
  const applyOverrides = (baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
    const next: NodeJS.ProcessEnv = { ...baseEnv };
    if (windows) {
      for (const inherited of Object.keys(next)) {
        if (inherited.toUpperCase() in overrides) delete next[inherited];
      }
    }
    return Object.assign(next, overrides);
  };

  if (explicitBaseEnv !== undefined) {
    return !environment || environment.length === 0
      ? explicitBaseEnv
      : applyOverrides(explicitBaseEnv);
  }
  const hostEnvironment = yield* HostProcess.Environment;
  return liveEnvironment(
    () => Object.keys(applyOverrides(inheritedProviderEnvironment(hostEnvironment))),
    (name) => {
      if (Object.hasOwn(overrides, name)) return overrides[name];
      if (windows && Object.hasOwn(overrides, name.toUpperCase())) return undefined;
      if (!Object.hasOwn(hostEnvironment, name)) return undefined;
      return inheritedProviderEnvironment({ [name]: hostEnvironment[name] })[name];
    },
  );
});
