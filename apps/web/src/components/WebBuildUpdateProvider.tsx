import { useAtomValue } from "@effect/atom-react";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import { isElectron } from "../env";
import { watchWebBuildUpdates } from "../webBuildUpdate";
import { createWebBuildUpdateUsage } from "../webBuildUpdateUsage";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { primaryServerConfigAtom } from "../state/server";
import { reportForkClientUsage, supportsForkClientUsage } from "../forkClientUsage";
import type { WebBuildUpdateUsageAction } from "@t3tools/contracts";

const WebBuildUpdateContext = createContext({
  available: false,
  noticeShown: () => {},
  refresh: () => {},
});

export function WebBuildUpdateProvider({ children }: { readonly children: ReactNode }) {
  const [availableBuildId, setAvailableBuildId] = useState<string | null>(null);
  const [usage] = useState(() => createWebBuildUpdateUsage(() => window.location.reload()));
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  const serverConfig = useAtomValue(primaryServerConfigAtom);
  // Re-create the reporter when support arrives so the pill observes the notice again.
  const supported = supportsForkClientUsage(serverConfig);
  const report =
    environmentId && supported
      ? (action: WebBuildUpdateUsageAction) =>
          reportForkClientUsage(environmentId, {
            feature: "web-build-update-notice",
            action,
          })
      : undefined;
  useEffect(() => {
    if (import.meta.env.DEV || isElectron) return;
    return watchWebBuildUpdates(import.meta.env.APP_BUILD_ID, setAvailableBuildId);
  }, []);

  const value = {
    available: availableBuildId !== null,
    noticeShown: () => {
      if (availableBuildId) usage.noticeShown(availableBuildId, report);
    },
    refresh: () => {
      if (availableBuildId) void usage.refresh(availableBuildId, report);
    },
  };

  return <WebBuildUpdateContext value={value}>{children}</WebBuildUpdateContext>;
}

export function useWebBuildUpdate() {
  return useContext(WebBuildUpdateContext);
}
