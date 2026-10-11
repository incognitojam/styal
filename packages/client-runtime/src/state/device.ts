import { type DeviceToolVersions, type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { Atom } from "effect/unstable/reactivity";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { request } from "../rpc/client.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createDeviceEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { environmentId: string }) => environmentId,
  };
  return {
    connectEnvironment: createEnvironmentCommand(runtime, {
      label: "environment-data:device:connect-environment",
      scheduler,
      concurrency,
      execute: (
        input: {
          targetEnvironmentId: EnvironmentId;
          targetLabel: string;
          url: string;
          sourceLabel: string;
        },
        _registry,
        environmentId,
      ) =>
        Effect.gen(function* () {
          const environments = yield* EnvironmentRegistry;
          const onTarget = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            environments.run(input.targetEnvironmentId, effect);
          yield* onTarget(
            request(WS_METHODS.deviceConfigure, { enabled: true, agentAccessEnabled: true }),
          );
          const grant = yield* onTarget(
            request(WS_METHODS.deviceCreateHostGrant, {
              sourceEnvironmentId: environmentId,
              sourceLabel: input.sourceLabel,
            }),
          );
          yield* request(WS_METHODS.deviceConnectEnvironment, {
            label: input.targetLabel,
            url: input.url,
            grant,
          }).pipe(
            Effect.onError(() =>
              onTarget(
                request(WS_METHODS.deviceRevokeHostGrant, { sessionId: grant.sessionId }),
              ).pipe(Effect.ignore),
            ),
          );
          yield* request(WS_METHODS.deviceConfigure, { enabled: true, agentAccessEnabled: true });
        }),
    }),
    disconnectEnvironment: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device:disconnect-environment",
      tag: WS_METHODS.deviceDisconnectEnvironment,
      scheduler,
      concurrency,
    }),
    /** Server-pushed device hosts, devices, and open sessions for one environment. */
    state: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:device:state",
      tag: WS_METHODS.subscribeDeviceState,
    }),
    configure: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device:configure",
      tag: WS_METHODS.deviceConfigure,
      scheduler,
      concurrency,
    }),
    testHost: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device:test-host",
      tag: WS_METHODS.deviceTestHost,
    }),
    list: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device:list",
      tag: WS_METHODS.deviceList,
      scheduler,
      concurrency,
    }),
    open: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device:open",
      tag: WS_METHODS.deviceOpen,
      scheduler,
      concurrency,
    }),
    close: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device:close",
      tag: WS_METHODS.deviceClose,
      scheduler,
      concurrency,
    }),
    shutdown: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device:shutdown",
      tag: WS_METHODS.deviceShutdown,
      scheduler,
      concurrency,
    }),
    detail: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device:detail",
      tag: WS_METHODS.deviceDetail,
      scheduler,
      concurrency,
    }),
    action: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device:action",
      tag: WS_METHODS.deviceAction,
      scheduler,
      concurrency,
    }),
  };
}

/** Unknown inventory is distinct from a completed check that found no install. */
export function deviceToolVersionLabels(tools: DeviceToolVersions | undefined) {
  if (!tools) return ["Device tool versions have not been checked."];
  return (
    [
      ["Device hub", tools.hub],
      ["Agent tools", tools.agent],
    ] as const
  ).map(([name, tool]) => {
    const installed = tool.installedVersions.length ? tool.installedVersions.join(", ") : "none";
    return `${name}: installed ${installed}; required ${tool.requiredVersion}${tool.runningVersion ? `; running ${tool.runningVersion}` : ""}.`;
  });
}

export function deviceToolUpdatePolicy(tools: DeviceToolVersions | undefined) {
  if (!tools) return "Versions have not been checked. Reconnect the host and check versions.";
  const outdated = [tools.hub, tools.agent].filter(
    (tool) =>
      tool.installedVersions.length > 0 && !tool.installedVersions.includes(tool.requiredVersion),
  );
  return outdated.length > 0
    ? "Update pending. Required tools will install automatically when next used. The host needs network access; an older install is not used as a fallback."
    : "Required tools are installed automatically when needed. Checking versions does not install or start anything.";
}
export const deviceToolUpdateOwnership =
  "This environment's T3 server chooses device tool versions for itself and its SSH hosts. Update that server to receive newer tool versions; updating only your browser or mobile app does not update a remote server.";

export function deviceSharingErrorMessage(cause: Cause.Cause<unknown>) {
  const error = Cause.squash(cause);
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "DeviceOperationError" &&
    "operation" in error &&
    typeof error.operation === "string"
  )
    return error.operation;
  return error instanceof Error
    ? error.message
    : "Device access could not be changed. Reconnect both environments and try again.";
}
