import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import { isElectron } from "../env";
import { watchWebBuildUpdates } from "../webBuildUpdate";
import { createWebBuildRefresh } from "../webBuildRefresh";

const WebBuildUpdateContext = createContext({
  available: false,
  refresh: () => {},
});

export function WebBuildUpdateProvider({ children }: { readonly children: ReactNode }) {
  const [availableBuildId, setAvailableBuildId] = useState<string | null>(null);
  const [refresh] = useState(() => createWebBuildRefresh(() => window.location.reload()));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- watches the deployed web build for updates until this provider unmounts
  useEffect(() => {
    if (import.meta.env.DEV || isElectron) return;
    return watchWebBuildUpdates(import.meta.env.APP_BUILD_ID, setAvailableBuildId);
  }, []);

  const value = {
    available: availableBuildId !== null,
    refresh: () => {
      if (availableBuildId) refresh();
    },
  };

  return <WebBuildUpdateContext value={value}>{children}</WebBuildUpdateContext>;
}

export function useWebBuildUpdate() {
  return useContext(WebBuildUpdateContext);
}
