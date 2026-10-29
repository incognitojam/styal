import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function PhysicalScreenOffSetting({
  disabled,
  id = "physical-android-screen-off",
}: {
  readonly disabled: boolean;
  readonly id?: string;
}) {
  const enabled = useScopedSettings().keepPhysicalAndroidScreensOff;
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      id={id}
      title="Turn off physical Android screens"
      forkFeature="physical-android-device-hold"
      serverScoped
      settingKeys={["keepPhysicalAndroidScreensOff"]}
      description="Turn off the screen of a phone connected to this environment while a thread holds it. Held phones stay awake either way, and streaming and input keep working."
      resetAction={
        !disabled && !enabled ? (
          <SettingResetButton
            label="physical screen off"
            onClick={() => updateSettings({ keepPhysicalAndroidScreensOff: true })}
          />
        ) : null
      }
      control={
        <Switch
          disabled={disabled}
          checked={enabled}
          aria-label="Turn off physical Android screens"
          onCheckedChange={(checked) =>
            updateSettings({ keepPhysicalAndroidScreensOff: Boolean(checked) })
          }
        />
      }
    />
  );
}
