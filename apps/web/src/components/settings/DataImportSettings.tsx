import { DataImportPanel } from "../import/DataImportPanel";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function DataImportSettingsPanel() {
  return (
    <SettingsPageContainer>
      <SettingsSection id={searchableSetting("import-data").id} title="Import data">
        <DataImportPanel />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
