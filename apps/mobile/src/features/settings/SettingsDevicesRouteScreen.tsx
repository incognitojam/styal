import {
  deviceSharingAddresses,
  deviceSharingErrorMessage,
  offlineDeviceShares,
} from "@t3tools/client-runtime/state/device";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentDeviceHostConfig } from "@t3tools/contracts";
import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Option from "effect/Option";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import { AppText } from "../../components/AppText";
import { deviceEnvironment, useDeviceState } from "../../state/device";
import { usePreparedConnection } from "../../state/session";
import { relayEnvironmentDiscovery } from "../../state/relay";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsScreen } from "./components/SettingsScreen";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

type SharingEnvironment = ReturnType<
  typeof useSettingsEnvironmentFilter
>["availableTargets"][number];

export function SettingsDevicesRouteScreen() {
  const [offlineError, setOfflineError] = useState<string | null>(null);
  const insets = useSafeAreaInsets();
  const { selectedTargets, availableTargets, selectedIds, selectedProjectKey } =
    useSettingsEnvironmentFilter();
  const disabled = selectedProjectKey !== null;
  const offlineShares = offlineDeviceShares(availableTargets, selectedIds);
  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title="Devices" trailing={<AndroidSettingsEnvironmentFilter />}>
        <ScreenScrollView
          contentInsetAdjustmentBehavior="automatic"
          className="flex-1"
          contentContainerClassName="gap-4 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          {selectedProjectKey !== null ? (
            <AppText className="text-sm text-foreground-muted">
              Select All projects to change environment device access.
            </AppText>
          ) : null}
          {offlineShares.map(({ agent, host }) => (
            <OfflineShare
              key={`${agent.environmentId}:${host.id}`}
              agent={agent}
              host={host}
              disabled={disabled}
              onError={setOfflineError}
            />
          ))}
          {offlineError ? (
            <AppText accessibilityRole="alert" className="px-2 text-sm text-danger-foreground">
              {offlineError}
            </AppText>
          ) : null}
          {selectedTargets.map((device) => (
            <EnvironmentDevices
              key={device.environmentId}
              device={device}
              agents={availableTargets.filter(
                (entry) => entry.environmentId !== device.environmentId,
              )}
              disabled={disabled}
            />
          ))}
          <AppText className="px-2 text-sm text-foreground-muted">
            {availableTargets.length < 2
              ? "Connect another environment to share simulators and emulators with it."
              : "Sharing lets agents on another environment use these simulators and emulators. It turns on device hub and agent device access on both, and keeps working when you close the app."}
          </AppText>
        </ScreenScrollView>
      </SettingsScreen>
    </>
  );
}

function OfflineShare(props: {
  agent: SharingEnvironment;
  host: EnvironmentDeviceHostConfig;
  disabled: boolean;
  onError: (error: string | null) => void;
}) {
  const disconnect = useAtomCommand(deviceEnvironment.disconnectEnvironment);
  const [pending, setPending] = useState(false);
  return (
    <>
      <SettingsSection title={`${props.host.label} devices`}>
        <SettingsSwitchRow
          icon="link"
          label={`Share with ${props.agent.label}`}
          subtitle="The device environment is offline. You can still remove this share."
          value
          disabled={props.disabled || pending}
          onValueChange={() => {
            props.onError(null);
            setPending(true);
            void disconnect({
              environmentId: props.agent.environmentId,
              input: { hostId: props.host.id },
            })
              .then((result) => {
                if (result._tag === "Failure")
                  props.onError(deviceSharingErrorMessage(result.cause));
              })
              .finally(() => setPending(false));
          }}
        />
      </SettingsSection>
    </>
  );
}

/** One environment's device settings and a sharing switch for each other connected environment. */
function EnvironmentDevices(props: {
  device: SharingEnvironment;
  agents: ReadonlyArray<SharingEnvironment>;
  disabled: boolean;
}) {
  const { device } = props;
  const prepared = Option.getOrNull(usePreparedConnection(device.environmentId));
  const linkUrl = useAtomValue(relayEnvironmentDiscovery.stateValueAtom).environments.get(
    device.environmentId,
  )?.environment.endpoint.httpBaseUrl;
  const addresses = deviceSharingAddresses({
    clientUrl: prepared?.httpBaseUrl ?? null,
    directEndpoints: device.serverConfig.directEndpoints,
    linkUrl,
  });
  const deviceState = useDeviceState(device.environmentId);
  const configure = useAtomCommand(deviceEnvironment.configure);
  const connect = useAtomCommand(deviceEnvironment.connectEnvironment);
  const disconnect = useAtomCommand(deviceEnvironment.disconnectEnvironment);
  // "configure" or the agent environment ID, so each row shows progress only for its own work.
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const perform = (kind: string, action: () => Promise<AtomCommandResult<unknown, unknown>>) => {
    setError(null);
    setPending(kind);
    void action()
      .then((result) => {
        if (result._tag === "Failure") setError(deviceSharingErrorMessage(result.cause));
      })
      .finally(() => setPending(null));
  };
  const busy = props.disabled || pending !== null;
  return (
    <>
      <SettingsSection title={`${device.label} devices`}>
        <SettingsSwitchRow
          icon="desktopcomputer"
          label="Device hub"
          value={device.serverConfig.settings.enableDeviceSupport}
          disabled={busy}
          onValueChange={(enabled) =>
            perform("configure", () =>
              configure({ environmentId: device.environmentId, input: { enabled } }),
            )
          }
        />
        <SettingsSwitchRow
          icon="bolt.circle"
          label="Agent device access"
          value={device.serverConfig.settings.enableAgentDeviceAccess}
          disabled={busy}
          onValueChange={(agentAccessEnabled) =>
            perform("configure", () =>
              configure({ environmentId: device.environmentId, input: { agentAccessEnabled } }),
            )
          }
        />
        {props.agents.map((agent) => (
          <SharingSwitch
            key={agent.environmentId}
            device={device}
            agent={agent}
            addresses={addresses}
            deviceLoaded={deviceState.loaded}
            deviceSupportsSharing={deviceState.state.supportsEnvironmentHosts === true}
            disabled={busy}
            onToggle={(enabled, host) => {
              if (enabled && addresses)
                perform(agent.environmentId, () =>
                  connect({
                    environmentId: agent.environmentId,
                    input: {
                      targetEnvironmentId: device.environmentId,
                      targetLabel: device.label,
                      urls: addresses,
                      sourceLabel: agent.label,
                    },
                  }),
                );
              else if (!enabled && host)
                perform(agent.environmentId, () =>
                  disconnect({ environmentId: agent.environmentId, input: { hostId: host.id } }),
                );
            }}
          />
        ))}
      </SettingsSection>
      {error ? (
        <AppText accessibilityRole="alert" className="px-2 text-sm text-danger-foreground">
          {error}
        </AppText>
      ) : null}
    </>
  );
}

function SharingSwitch(props: {
  device: SharingEnvironment;
  agent: SharingEnvironment;
  addresses: readonly [string, ...string[]] | null;
  deviceLoaded: boolean;
  deviceSupportsSharing: boolean;
  disabled: boolean;
  onToggle: (enabled: boolean, host: EnvironmentDeviceHostConfig | undefined) => void;
}) {
  const { device, agent, addresses } = props;
  const agentState = useDeviceState(agent.environmentId);
  // The grant lives on the environment whose agents use the devices.
  const host = agent.serverConfig.settings.environmentDeviceHosts?.find(
    (entry) => entry.environmentId === device.environmentId,
  );
  const checked = props.deviceLoaded && agentState.loaded;
  const compatible =
    props.deviceSupportsSharing && agentState.state.supportsEnvironmentHostAddresses === true;
  const connectedUrl =
    host && agentState.state.hosts.find((entry) => entry.id === host.id)?.connectedUrl;
  const subtitle = host
    ? connectedUrl
      ? `Last connected at ${connectedUrl}. Addresses are selected automatically.`
      : `Agents on ${agent.label} can use these devices. Addresses are selected automatically.`
    : !checked
      ? "Checking whether both environments support sharing…"
      : !compatible
        ? "Update both environments to share devices."
        : addresses
          ? undefined
          : `No network address is available for ${device.label}. Device sharing needs a LAN, Tailscale, styal Link, or custom address.`;
  return (
    <SettingsSwitchRow
      icon="link"
      label={`Share with ${agent.label}`}
      subtitle={subtitle}
      value={host !== undefined}
      disabled={props.disabled || (!host && (!checked || !compatible || !addresses))}
      onValueChange={(enabled) => props.onToggle(enabled, host)}
    />
  );
}
