import { createFileRoute } from "@tanstack/react-router";

import { HardwareSettingsPanel } from "../components/settings/HardwareSettings";

export const Route = createFileRoute("/settings/hardware")({
  component: HardwareSettingsPanel,
});
