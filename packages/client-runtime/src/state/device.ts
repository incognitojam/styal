import {
  type AdvertisedEndpoint,
  type DeviceToolVersions,
  type EnvironmentDeviceHostConfig,
  type EnvironmentId,
  type ServerDirectEndpoint,
  WS_METHODS,
} from "@t3tools/contracts";
import { isLocalLoopbackHost } from "@t3tools/shared/hostClassification";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { request } from "../rpc/client.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/** Saved shares remain removable through their connected agent environment. */
export function offlineDeviceShares<
  T extends {
    readonly environmentId: EnvironmentId;
    readonly serverConfig: {
      readonly settings: {
        readonly environmentDeviceHosts: readonly EnvironmentDeviceHostConfig[];
      };
    } | null;
  },
>(connected: readonly T[], selectedIds: ReadonlySet<EnvironmentId> | null) {
  const connectedIds = new Set(connected.map((entry) => entry.environmentId));
  return connected.flatMap((agent) =>
    (agent.serverConfig?.settings.environmentDeviceHosts ?? [])
      .filter(
        (host) =>
          !connectedIds.has(host.environmentId) &&
          (selectedIds === null ||
            selectedIds.has(agent.environmentId) ||
            selectedIds.has(host.environmentId)),
      )
      .map((host) => ({ agent, host })),
  );
}

export function createDeviceEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { environmentId: string }) => environmentId,
  };
  // An EAS Simulator start can take minutes; it must not hold up powering off
  // another device or turning device support off, so each device opens in its
  // own lane. Every EAS start opens the same catalog device, so the thread is
  // part of the lane too.
  const openConcurrency = {
    mode: "serial" as const,
    key: ({
      environmentId,
      input,
    }: {
      environmentId: string;
      input: {
        readonly threadId: string;
        readonly hostId?: string | undefined;
        readonly deviceId: string;
      };
    }) =>
      JSON.stringify([environmentId, "open", input.threadId, input.hostId ?? null, input.deviceId]),
  };
  return {
    connectEnvironment: createEnvironmentCommand(runtime, {
      label: "environment-data:device:connect-environment",
      scheduler,
      concurrency,
      execute: Effect.fn("device.connectEnvironment")(function* (
        input: {
          targetEnvironmentId: EnvironmentId;
          targetLabel: string;
          urls: readonly [string, ...string[]];
          sourceLabel: string;
        },
        _registry,
        environmentId,
      ) {
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
          urls: input.urls,
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
    easAccount: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device:eas-account",
      tag: WS_METHODS.deviceEasAccount,
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
      concurrency: openConcurrency,
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
  "This environment's styal server chooses device tool versions for itself and its SSH hosts. Update that server to receive newer tool versions; updating only your browser or mobile app does not update a remote server.";

export function deviceSharingErrorMessage(cause: Cause.Cause<unknown>) {
  const error = Cause.squash(cause);
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "DeviceHostUnavailableError" &&
    "reason" in error &&
    typeof error.reason === "string"
  )
    return error.reason;
  return error instanceof Error
    ? error.message
    : "Device access could not be changed. Reconnect both environments and try again.";
}

const usableDesktopEndpoint = (endpoint: AdvertisedEndpoint) =>
  endpoint.status !== "unavailable" && endpoint.reachability !== "loopback";

/**
 * Addresses the agent environment can try for the device environment, in
 * order: the client's own address, the desktop app's default network address,
 * the LAN and tailnet addresses the device environment's server reports
 * listening on, the desktop app's other network addresses, then styal Link.
 */
export function deviceSharingAddresses(input: {
  readonly clientUrl: string | null;
  /** `directEndpoints` from the device environment's server config. */
  readonly directEndpoints?: ReadonlyArray<ServerDirectEndpoint> | undefined;
  /** Only for the desktop app's own server, from its Network settings. */
  readonly desktopEndpoints?: ReadonlyArray<AdvertisedEndpoint> | undefined;
  readonly desktopDefaultEndpoint?: AdvertisedEndpoint | null | undefined;
  readonly linkUrl?: string | undefined;
}): readonly [string, ...string[]] | null {
  const urls = new Set<string>();
  const candidates = [
    input.clientUrl,
    input.desktopDefaultEndpoint && usableDesktopEndpoint(input.desktopDefaultEndpoint)
      ? input.desktopDefaultEndpoint.httpBaseUrl
      : null,
    ...(input.directEndpoints ?? []).map((endpoint) => endpoint.httpBaseUrl),
    // Desktop addresses stay as fallbacks: a LAN hostname override, a custom
    // address, or an older server without reported addresses has no other source.
    ...(input.desktopEndpoints ?? [])
      .filter(usableDesktopEndpoint)
      .map((endpoint) => endpoint.httpBaseUrl),
    input.linkUrl,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        isLocalLoopbackHost(url.hostname) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        continue;
      urls.add(url.toString().replace(/\/+$/, ""));
    } catch {
      // An invalid client or custom address cannot be used by another environment.
    }
  }
  const [first, ...rest] = [...urls];
  return first ? [first, ...rest] : null;
}
