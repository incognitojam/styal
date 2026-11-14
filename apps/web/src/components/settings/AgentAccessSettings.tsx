import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";

import { ScopedSwitch } from "./ScopedSwitch";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import {
  useClearScopedSettings,
  useScopedSettings,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function AgentBrowserAccessSetting({ id }: { readonly id: string }) {
  const { scope } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const clearOverrides = useClearScopedSettings();
  const projectScope = scope.kind === "project" || scope.kind === "checkout";
  const change = (enabled: boolean) => {
    return updateSettings({ enableAgentBrowserAccess: enabled });
  };
  return (
    <SettingsRow
      id={id}
      serverScoped
      settingKeys={["enableAgentBrowserAccess"]}
      title="Agent browser access"
      onResetOverride={() => {
        return clearOverrides(["enableAgentBrowserAccess"]);
      }}
      description={
        projectScope
          ? "Allow agents in this project to use the shared browser. Applies when the agent session next starts."
          : "Allow agents on this environment to use the shared browser. Projects can override it."
      }
      resetAction={
        settings.enableAgentBrowserAccess !== DEFAULT_SERVER_SETTINGS.enableAgentBrowserAccess ? (
          <SettingResetButton
            label="default browser access"
            onClick={() => change(DEFAULT_SERVER_SETTINGS.enableAgentBrowserAccess)}
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["enableAgentBrowserAccess"]}
          aria-label="Agent browser access"
          checked={settings.enableAgentBrowserAccess}
          onCheckedChange={change}
        />
      }
    />
  );
}

export function ProjectAgentAccessSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const clearOverrides = useClearScopedSettings();
  return (
    <SettingsSection id="project-agent-access" title="Agent access">
      <AgentBrowserAccessSetting id="project-agent-browser-access" />
      <SettingsRow
        id="project-agent-device-access"
        serverScoped
        settingKeys={["enableAgentDeviceAccess"]}
        title="Agent device access"
        onResetOverride={() => {
          return clearOverrides(["enableAgentDeviceAccess"]);
        }}
        description="Allow agents in this project to control devices. Device support must be enabled on the environment. Applies when the agent session next starts."
        control={
          <ScopedSwitch
            settingKeys={["enableAgentDeviceAccess"]}
            aria-label="Agent device access"
            checked={settings.enableAgentDeviceAccess}
            onCheckedChange={(enabled) => {
              updateSettings({ enableAgentDeviceAccess: enabled });
            }}
          />
        }
      />
    </SettingsSection>
  );
}
