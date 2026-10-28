import { SIMULATOR_MEMORY_DESCRIPTION } from "@t3tools/contracts";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function SimulatorMemorySetting() {
  const mode = useScopedSettings().simulatorMemoryMode;
  const mixed = useScopedSettingsMixed(["simulatorMemoryMode"]);
  const update = useUpdateScopedSettings();
  return (
    <SettingsRow
      title="Simulator memory"
      forkFeature="simulator-memory-profiles"
      serverScoped
      settingKeys={["simulatorMemoryMode"]}
      description={SIMULATOR_MEMORY_DESCRIPTION}
      control={
        <Select
          value={mixed ? "" : mode}
          onValueChange={(value) => {
            if (value === "standard" || value === "low-memory")
              update({ simulatorMemoryMode: value });
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Simulator memory">
            <SelectValue>
              {mixed ? "Mixed" : mode === "low-memory" ? "Low memory" : "Standard"}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem value="standard">Standard</SelectItem>
            <SelectItem value="low-memory">Low memory</SelectItem>
          </SelectPopup>
        </Select>
      }
    />
  );
}

export function ProjectSimulatorMemorySettings() {
  return (
    <SettingsSection id="project-simulator-memory" title="Devices">
      <SimulatorMemorySetting />
    </SettingsSection>
  );
}
