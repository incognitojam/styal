import { createFileRoute } from "@tanstack/react-router";

import { ConnectCliAuthorizeSurface } from "../components/cloud/ConnectCliAuthSurface";

export const Route = createFileRoute("/connect")({
  component: ConnectCliAuthorizeSurface,
});
