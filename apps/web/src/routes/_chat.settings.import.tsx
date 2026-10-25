import { createFileRoute } from "@tanstack/react-router";

import { DataImportSettingsPanel } from "../components/settings/DataImportSettings";

export const Route = createFileRoute("/_chat/settings/import")({
  component: DataImportSettingsPanel,
});
