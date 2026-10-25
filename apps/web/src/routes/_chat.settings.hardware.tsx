import { createFileRoute } from "@tanstack/react-router";

import { HardwareSettingsPanel } from "../components/settings/HardwareSettings";

export const Route = createFileRoute("/_chat/settings/hardware")({
  component: HardwareSettingsPanel,
});
