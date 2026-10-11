import {
  deviceSharingErrorMessage,
  isClientOnlyDeviceAddress,
  suggestDeviceSharingAddress,
} from "@t3tools/client-runtime/state/device";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Option from "effect/Option";
import type { EnvironmentId } from "@t3tools/contracts";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import { AppText, AppTextInput } from "../../components/AppText";
import { deviceEnvironment, useDeviceState } from "../../state/device";
import { usePreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsScreen } from "./components/SettingsScreen";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

export function SettingsDevicesRouteScreen() {
  const insets = useSafeAreaInsets();
  const { selectedTargets, availableTargets, selectedProjectKey } = useSettingsEnvironmentFilter();
  const [sourceId, setSourceId] = useState<EnvironmentId | null>(null);
  const [targetId, setTargetId] = useState<EnvironmentId | null>(null);
  // "connect", a revoked host's key, or "other", so each row shows progress only for its own work.
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const source =
    selectedTargets.find((entry) => entry.environmentId === sourceId) ?? selectedTargets[0];
  const candidates = availableTargets.filter(
    (entry) => entry.environmentId !== source?.environmentId,
  );
  const target = candidates.find((entry) => entry.environmentId === targetId) ?? candidates[0];
  const prepared = Option.getOrNull(usePreparedConnection(target?.environmentId ?? null));
  // An address typed for one device environment does not carry over to another.
  const [addressDraft, setAddressDraft] = useState<{
    readonly targetId: EnvironmentId;
    readonly value: string;
  } | null>(null);
  const url = (
    addressDraft && addressDraft.targetId === target?.environmentId
      ? addressDraft.value
      : (suggestDeviceSharingAddress(prepared?.httpBaseUrl ?? null) ?? "")
  ).trim();
  const clientOnly = url !== "" && isClientOnlyDeviceAddress(url);
  const sourceState = useDeviceState(source?.environmentId ?? null);
  const targetState = useDeviceState(target?.environmentId ?? null);
  const connect = useAtomCommand(deviceEnvironment.connectEnvironment);
  const disconnect = useAtomCommand(deviceEnvironment.disconnectEnvironment);
  const configure = useAtomCommand(deviceEnvironment.configure);
  const disabled = pending !== null || selectedProjectKey !== null;
  const checked = sourceState.loaded && targetState.loaded;
  const compatible =
    checked &&
    sourceState.state.supportsEnvironmentHosts &&
    targetState.state.supportsEnvironmentHosts;
  const linked = source?.serverConfig.settings.environmentDeviceHosts?.some(
    (host) => host.environmentId === target?.environmentId,
  );
  const perform = (action: () => Promise<AtomCommandResult<unknown, unknown>>, kind = "other") => {
    setError(null);
    setPending(kind);
    void action()
      .then((result) => {
        if (result._tag === "Failure") setError(deviceSharingErrorMessage(result.cause));
      })
      .finally(() => setPending(null));
  };
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
          <SettingsSection title="Agents run on">
            {selectedTargets.map((entry) => (
              <SettingsActionRow
                key={entry.environmentId}
                icon={
                  source?.environmentId === entry.environmentId
                    ? "checkmark.circle"
                    : "desktopcomputer"
                }
                label={entry.label}
                disabled={disabled}
                onPress={() => setSourceId(entry.environmentId)}
              />
            ))}
          </SettingsSection>
          {source ? (
            <SettingsSection title={`${source.label} devices`}>
              <SettingsSwitchRow
                icon="desktopcomputer"
                label="Device hub"
                value={source.serverConfig.settings.enableDeviceSupport}
                disabled={disabled}
                onValueChange={(enabled) =>
                  perform(() =>
                    configure({ environmentId: source.environmentId, input: { enabled } }),
                  )
                }
              />
              <SettingsSwitchRow
                icon="bolt.circle"
                label="Agent device access"
                value={source.serverConfig.settings.enableAgentDeviceAccess}
                disabled={disabled}
                onValueChange={(agentAccessEnabled) =>
                  perform(() =>
                    configure({
                      environmentId: source.environmentId,
                      input: { agentAccessEnabled },
                    }),
                  )
                }
              />
            </SettingsSection>
          ) : null}
          <SettingsSection title="Use devices from">
            {candidates.map((entry) => (
              <SettingsActionRow
                key={entry.environmentId}
                icon={
                  target?.environmentId === entry.environmentId
                    ? "checkmark.circle"
                    : "desktopcomputer"
                }
                label={entry.label}
                disabled={disabled}
                onPress={() => setTargetId(entry.environmentId)}
              />
            ))}
          </SettingsSection>
          {source && target ? (
            <View className="gap-3">
              <AppText className="px-2 text-sm text-foreground-muted">
                {!checked
                  ? "Checking whether both environments support device sharing…"
                  : compatible
                    ? `${source.label} agents will be allowed to control devices on ${target.label}. Device hub and agent access will be enabled on both. Access keeps working when you close the app.`
                    : "Update both environments to a version that supports device sharing."}
              </AppText>
              <SettingsSection title={`Address ${source.label} uses to reach ${target.label}`}>
                <View className="px-4 py-3">
                  <AppTextInput
                    accessibilityLabel={`Address ${source.label} uses to reach ${target.label}`}
                    value={url}
                    onChangeText={(value) =>
                      setAddressDraft({ targetId: target.environmentId, value })
                    }
                    editable={!disabled}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    className="min-h-10 rounded-xl px-3 py-2 text-base text-foreground"
                  />
                </View>
              </SettingsSection>
              {clientOnly ? (
                <AppText className="px-2 text-sm text-foreground-muted">
                  This address only works if {source.label} runs on the same machine as{" "}
                  {target.label}. Otherwise enter a LAN, Tailscale, or styal Link address for{" "}
                  {target.label}.
                </AppText>
              ) : null}
              <SettingsSection>
                <SettingsActionRow
                  icon="link"
                  label={linked ? "Reconnect device access" : "Allow device access"}
                  loading={pending === "connect"}
                  disabled={disabled || !url || !compatible}
                  onPress={() => {
                    if (!url) return;
                    perform(
                      () =>
                        connect({
                          environmentId: source.environmentId,
                          input: {
                            targetEnvironmentId: target.environmentId,
                            targetLabel: target.label,
                            url,
                            sourceLabel: source.label,
                          },
                        }),
                      "connect",
                    );
                  }}
                />
              </SettingsSection>
            </View>
          ) : (
            <AppText className="px-2 text-sm text-foreground-muted">
              Connect two environments to share simulators and emulators between them.
            </AppText>
          )}
          {error ? (
            <AppText accessibilityRole="alert" className="px-2 text-sm text-danger-foreground">
              {error}
            </AppText>
          ) : null}
          {selectedTargets.map((entry) =>
            (entry.serverConfig.settings.environmentDeviceHosts ?? []).map((host) => (
              <SettingsSection
                key={`${entry.environmentId}:${host.id}`}
                title={`${host.label} → ${entry.label}`}
              >
                <SettingsActionRow
                  icon="trash"
                  label="Revoke device access"
                  tone="danger"
                  loading={pending === `${entry.environmentId}:${host.id}`}
                  disabled={disabled}
                  onPress={() =>
                    perform(
                      () =>
                        disconnect({
                          environmentId: entry.environmentId,
                          input: { hostId: host.id },
                        }),
                      `${entry.environmentId}:${host.id}`,
                    )
                  }
                />
              </SettingsSection>
            )),
          )}
        </ScreenScrollView>
      </SettingsScreen>
    </>
  );
}
