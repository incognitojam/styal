import { DataImportPanel } from "../import/DataImportPanel";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function DataImportSettingsPanel() {
  return (
    <SettingsPageContainer>
      <SettingsSection id={searchableSetting("import-data").id} title="Import data">
        <div className="p-3 sm:p-4">
          <DataImportPanel source="legacy" />
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
