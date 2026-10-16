import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import { isElectron } from "../env";
import { watchWebBuildUpdates } from "../webBuildUpdate";

const WebBuildUpdateContext = createContext(false);

export function WebBuildUpdateProvider({ children }: { readonly children: ReactNode }) {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    if (import.meta.env.DEV || isElectron) return;
    return watchWebBuildUpdates(import.meta.env.APP_BUILD_ID, setAvailable);
  }, []);

  return <WebBuildUpdateContext value={available}>{children}</WebBuildUpdateContext>;
}

export function useWebBuildUpdateAvailable() {
  return useContext(WebBuildUpdateContext);
}
