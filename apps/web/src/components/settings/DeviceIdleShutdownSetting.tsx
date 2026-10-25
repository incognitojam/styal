import {
  DEFAULT_DEVICE_IDLE_SHUTDOWN_MINUTES,
  DEVICE_IDLE_SHUTDOWN_CHOICES,
  deviceIdleShutdownLabel,
} from "@t3tools/contracts";
import { reportForkClientUsage } from "~/forkClientUsage";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { useSettingsScope } from "./SettingsScopeContext";

/** Idle period after which the environment shuts down devices it started. */
export function DeviceIdleShutdownSetting({
  disabled,
  id = "device-idle-shutdown",
}: {
  readonly disabled: boolean;
  readonly id?: string;
}) {
  const minutes = useScopedSettings().deviceIdleShutdownMinutes;
  const updateSettings = useUpdateScopedSettings();
  const { environment } = useSettingsScope();
  const change = (deviceIdleShutdownMinutes: number | null) => {
    void reportForkClientUsage(environment?.environmentId, {
      feature: "integration-settings",
      action: "change_requested",
      setting: "device_idle_shutdown",
      settingScope: "environment",
    });
    return updateSettings({ deviceIdleShutdownMinutes });
  };
  const choices = DEVICE_IDLE_SHUTDOWN_CHOICES.includes(minutes)
    ? DEVICE_IDLE_SHUTDOWN_CHOICES
    : [minutes, ...DEVICE_IDLE_SHUTDOWN_CHOICES];
  return (
    <SettingsRow
      id={id}
      title="Shut down idle devices"
      forkFeature="device-idle-shutdown"
      serverScoped
      settingKeys={["deviceIdleShutdownMinutes"]}
      description="Shut down simulators and emulators styal started once no agent is working with them and nobody is viewing them. Devices you started yourself keep running."
      resetAction={
        !disabled && minutes !== DEFAULT_DEVICE_IDLE_SHUTDOWN_MINUTES ? (
          <SettingResetButton
            label="idle shutdown"
            onClick={() => change(DEFAULT_DEVICE_IDLE_SHUTDOWN_MINUTES)}
          />
        ) : null
      }
      control={
        <Select
          disabled={disabled}
          value={String(minutes)}
          onValueChange={(value) => change(value === "null" ? null : Number(value))}
        >
          <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Shut down idle devices">
            <SelectValue>{deviceIdleShutdownLabel(minutes)}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {choices.map((choice) => (
              <SelectItem hideIndicator key={String(choice)} value={String(choice)}>
                {deviceIdleShutdownLabel(choice)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
