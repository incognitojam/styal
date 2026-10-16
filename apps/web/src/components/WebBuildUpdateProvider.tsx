import { useAtomValue } from "@effect/atom-react";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { isElectron } from "../env";
import { watchWebBuildUpdates } from "../webBuildUpdate";
import { createWebBuildUpdateUsage } from "../webBuildUpdateUsage";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { primaryServerConfigAtom } from "../state/server";
import { reportForkClientUsage } from "../forkClientUsage";
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
  const supported = serverConfig?.environment.capabilities.forkClientUsage === true;
  const report = useMemo(
    () =>
      environmentId && supported
        ? (action: WebBuildUpdateUsageAction) =>
            reportForkClientUsage(environmentId, {
              feature: "web-build-update-notice",
              action,
            })
        : undefined,
    [environmentId, supported],
  );
  useEffect(() => {
    if (import.meta.env.DEV || isElectron) return;
    return watchWebBuildUpdates(import.meta.env.APP_BUILD_ID, setAvailableBuildId);
  }, []);

  const value = useMemo(
    () => ({
      available: availableBuildId !== null,
      noticeShown: () => {
        if (availableBuildId) usage.noticeShown(availableBuildId, report);
      },
      refresh: () => {
        if (availableBuildId) void usage.refresh(availableBuildId, report);
      },
    }),
    [availableBuildId, report, usage],
  );

  return <WebBuildUpdateContext value={value}>{children}</WebBuildUpdateContext>;
}

export function useWebBuildUpdate() {
  return useContext(WebBuildUpdateContext);
}
