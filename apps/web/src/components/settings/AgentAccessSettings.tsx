import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { reportForkClientUsage } from "~/forkClientUsage";

import { ScopedSwitch } from "./ScopedSwitch";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import {
  useClearScopedSettings,
  useScopedSettings,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function AgentBrowserAccessSetting({ id }: { readonly id: string }) {
  const { scope, environment } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const clearOverrides = useClearScopedSettings();
  const projectScope = scope.kind === "project" || scope.kind === "checkout";
  const recordChange = () =>
    reportForkClientUsage(environment?.environmentId, {
      feature: "integration-settings",
      action: "change_requested",
      setting: "browser_access",
      settingScope: projectScope ? "project" : "environment",
    });
  const change = (enabled: boolean) => {
    void recordChange();
    return updateSettings({ enableAgentBrowserAccess: enabled });
  };
  return (
    <SettingsRow
      id={id}
      serverScoped
      settingKeys={["enableAgentBrowserAccess"]}
      title="Agent browser access"
      onResetOverride={() => {
        void recordChange();
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

export function AgentCrossProjectAccessSetting({ id }: { readonly id: string }) {
  const { scope } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const clearOverrides = useClearScopedSettings();
  const projectScope = scope.kind === "project" || scope.kind === "checkout";
  const change = (enabled: boolean) => updateSettings({ enableAgentCrossProjectAccess: enabled });
  return (
    <SettingsRow
      id={id}
      serverScoped
      settingKeys={["enableAgentCrossProjectAccess"]}
      title="Agent access to other projects"
      onResetOverride={() => clearOverrides(["enableAgentCrossProjectAccess"])}
      description={
        projectScope
          ? "Allow agents in this project to read, message and manage threads, projects and scheduled tasks in other projects. Applies to running agents right away."
          : "Allow agents on this environment to read, message and manage threads, projects and scheduled tasks in other projects. Projects can override it."
      }
      resetAction={
        settings.enableAgentCrossProjectAccess !==
        DEFAULT_SERVER_SETTINGS.enableAgentCrossProjectAccess ? (
          <SettingResetButton
            label="default access to other projects"
            onClick={() => change(DEFAULT_SERVER_SETTINGS.enableAgentCrossProjectAccess)}
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["enableAgentCrossProjectAccess"]}
          aria-label="Agent access to other projects"
          checked={settings.enableAgentCrossProjectAccess}
          onCheckedChange={change}
        />
      }
    />
  );
}

export function ProjectAgentAccessSettings() {
  const { environment } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const clearOverrides = useClearScopedSettings();
  const recordChange = () =>
    reportForkClientUsage(environment?.environmentId, {
      feature: "integration-settings",
      action: "change_requested",
      setting: "device_access",
      settingScope: "project",
    });
  return (
    <SettingsSection id="project-agent-access" title="Agent access">
      <AgentBrowserAccessSetting id="project-agent-browser-access" />
      <AgentCrossProjectAccessSetting id="project-agent-cross-project-access" />
      <SettingsRow
        id="project-agent-device-access"
        serverScoped
        settingKeys={["enableAgentDeviceAccess"]}
        title="Agent device access"
        onResetOverride={() => {
          void recordChange();
          return clearOverrides(["enableAgentDeviceAccess"]);
        }}
        description="Allow agents in this project to control devices. Device support must be enabled on the environment. Applies when the agent session next starts."
        control={
          <ScopedSwitch
            settingKeys={["enableAgentDeviceAccess"]}
            aria-label="Agent device access"
            checked={settings.enableAgentDeviceAccess}
            onCheckedChange={(enabled) => {
              void recordChange();
              updateSettings({ enableAgentDeviceAccess: enabled });
            }}
          />
        }
      />
    </SettingsSection>
  );
}
