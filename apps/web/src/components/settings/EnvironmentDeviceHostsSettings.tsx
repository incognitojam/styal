import { Link } from "@tanstack/react-router";
import {
  deviceSharingAddresses,
  deviceSharingErrorMessage,
} from "@t3tools/client-runtime/state/device";
import { useState } from "react";
import { deviceEnvironment, useDeviceState } from "../../state/device";
import { desktopNetworkAccessStateAtom } from "../../state/desktopNetworkAccess";
import {
  useEnvironments,
  useEnvironmentHttpBaseUrl,
  usePrimaryEnvironmentId,
  useRelayEnvironmentDiscovery,
} from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useUiStateStore } from "~/uiStateStore";
import { Switch } from "../ui/switch";
import { selectDesktopDefaultEndpoint } from "./ConnectionsSettings.logic";
import { SettingsRow } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

type SharingEnvironment = ReturnType<typeof useSettingsScope>["connectedEnvironments"][number];

export function EnvironmentDeviceHostsSettings() {
  const { scope, connectedEnvironments } = useSettingsScope();
  const { environments } = useEnvironments();
  const disabled = scope.kind === "project" || scope.kind === "checkout";
  const reachable = environments.filter(
    (entry) => entry.connection.phase === "connected" && entry.serverConfig !== null,
  );
  return (
    <SettingsRow
      id="environment-device-hosts"
      title="Share devices with other environments"
      serverScoped
      settingKeys={["environmentDeviceHosts"]}
      description="Let agents on your other connected environments use this environment's simulators and emulators. Sharing turns on device hub and agent device access on both, and keeps working when you close this client."
    >
      <div className="pt-3 pb-2">
        {reachable.length < 2 ? (
          <p className="text-sm text-muted-foreground">
            Connect another environment to share devices with it.
          </p>
        ) : (
          connectedEnvironments.map((device) => (
            <SharedDevices
              key={device.environmentId}
              device={device}
              agents={reachable.filter((entry) => entry.environmentId !== device.environmentId)}
              showLabel={connectedEnvironments.length > 1}
              disabled={disabled}
            />
          ))
        )}
      </div>
    </SettingsRow>
  );
}

/** One device environment and a sharing switch for each other connected environment. */
function SharedDevices(props: {
  device: SharingEnvironment;
  agents: ReadonlyArray<SharingEnvironment>;
  showLabel: boolean;
  disabled: boolean;
}) {
  const { device } = props;
  const clientUrl = useEnvironmentHttpBaseUrl(device.environmentId);
  const linkUrl = useRelayEnvironmentDiscovery().environments.get(device.environmentId)?.environment
    .endpoint.httpBaseUrl;
  // The desktop advertises all addresses; its saved default only sets their order.
  const isDesktopServer =
    device.environmentId === usePrimaryEnvironmentId() && window.desktopBridge !== undefined;
  const networkAccess = useEnvironmentQuery(isDesktopServer ? desktopNetworkAccessStateAtom : null);
  const defaultEndpointKey = useUiStateStore((state) => state.defaultAdvertisedEndpointKey);
  const desktopDefaultEndpoint = networkAccess.data
    ? selectDesktopDefaultEndpoint(
        networkAccess.data.advertisedEndpoints,
        networkAccess.data.serverExposureState.mode === "network-accessible",
        defaultEndpointKey,
      )
    : null;
  const addresses = deviceSharingAddresses(
    clientUrl,
    networkAccess.data?.advertisedEndpoints,
    desktopDefaultEndpoint,
    linkUrl ? [linkUrl] : [],
  );
  const deviceState = useDeviceState(device.environmentId);
  return (
    <div>
      {props.showLabel ? (
        <p className="pt-3 pb-1 text-xs font-medium text-muted-foreground">{device.label}</p>
      ) : null}
      {props.agents.map((agent) => (
        <SharingSwitch
          key={agent.environmentId}
          device={device}
          agent={agent}
          addresses={addresses}
          addressLoaded={!isDesktopServer || networkAccess.data !== null}
          isDesktopServer={isDesktopServer}
          deviceSupportsSharing={deviceState.state.supportsEnvironmentHosts === true}
          deviceLoaded={deviceState.loaded}
          disabled={props.disabled}
        />
      ))}
    </div>
  );
}

function SharingSwitch(props: {
  device: SharingEnvironment;
  agent: SharingEnvironment;
  addresses: readonly [string, ...string[]] | null;
  addressLoaded: boolean;
  isDesktopServer: boolean;
  deviceSupportsSharing: boolean;
  deviceLoaded: boolean;
  disabled: boolean;
}) {
  const { device, agent, addresses } = props;
  const agentState = useDeviceState(agent.environmentId);
  const connect = useAtomCommand(deviceEnvironment.connectEnvironment);
  const disconnect = useAtomCommand(deviceEnvironment.disconnectEnvironment);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The grant lives on the environment whose agents use the devices.
  const host = agent.serverConfig?.settings.environmentDeviceHosts.find(
    (entry) => entry.environmentId === device.environmentId,
  );
  const checked = props.deviceLoaded && agentState.loaded && props.addressLoaded;
  const compatible =
    props.deviceSupportsSharing && agentState.state.supportsEnvironmentHostAddresses === true;
  const connectedUrl =
    host && agentState.state.hosts.find((entry) => entry.id === host.id)?.connectedUrl;
  const status = host ? (
    connectedUrl ? (
      `Last connected at ${connectedUrl}. Other shared addresses are tried automatically if needed.`
    ) : (
      `Agents on ${agent.label} can use ${device.label}'s devices. Addresses are selected automatically.`
    )
  ) : !checked ? (
    "Checking whether both environments support device sharing…"
  ) : !compatible ? (
    "Update both environments to a version that supports device sharing."
  ) : addresses ? (
    `Agents on ${agent.label} will use an available address automatically.`
  ) : props.isDesktopServer ? (
    <>
      Other machines cannot reach {device.label}. Turn on network access or Tailscale in{" "}
      <Link to="/settings/connections" className="text-foreground underline underline-offset-2">
        Connections
      </Link>
      .
    </>
  ) : (
    `No network address is available for ${device.label}. Device sharing needs a LAN, Tailscale, styal Link, or custom address.`
  );
  const toggle = (enabled: boolean) => {
    const action =
      enabled && addresses
        ? connect({
            environmentId: agent.environmentId,
            input: {
              targetEnvironmentId: device.environmentId,
              targetLabel: device.label,
              urls: addresses,
              sourceLabel: agent.label,
            },
          })
        : host
          ? disconnect({ environmentId: agent.environmentId, input: { hostId: host.id } })
          : null;
    if (!action) return;
    setError(null);
    setPending(true);
    void action
      .then((result) => {
        if (result._tag === "Failure") setError(deviceSharingErrorMessage(result.cause));
      })
      .finally(() => setPending(false));
  };
  return (
    <div className="flex items-start gap-3 border-t border-border/50 py-2 first:border-t-0">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">Share with {agent.label}</p>
        <p className="text-xs text-muted-foreground">{status}</p>
        {error ? (
          <p role="status" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      <Switch
        checked={host !== undefined}
        disabled={props.disabled || pending || (!host && (!checked || !compatible || !addresses))}
        onCheckedChange={toggle}
        aria-label={`Share ${device.label} devices with ${agent.label}`}
      />
    </div>
  );
}
