import React from "react";
import ReactDOM from "react-dom/client";

import "@fontsource-variable/inter";
import "./index.css";
import "./fork-theme.css";

import { hasCloudPublicConfig } from "./cloud/publicConfig";
import { ManagedRelayAuthProvider } from "./cloud/managedAuth";
import { startAppServices } from "./appInit";
import { AppRoot } from "./AppRoot";
import { whenLocaleReady } from "./i18n/runtime";
import { clearChunkReloadGuard, reloadOnceForChunkLoadError } from "./lib/chunkReloadGuard";
import { cleanupAbandonedHostedBrowserStorage } from "./hostedStorageCleanup";

void cleanupAbandonedHostedBrowserStorage();

const router = startAppServices();

let chunkLoadFailed = false;
let reloadScheduled = false;
window.addEventListener("vite:preloadError", (event) => {
  chunkLoadFailed = true;
  if (reloadOnceForChunkLoadError()) {
    reloadScheduled = true;
    event.preventDefault();
  }
});

const app = hasCloudPublicConfig() ? (
  <ManagedRelayAuthProvider>
    <AppRoot router={router} />
  </ManagedRelayAuthProvider>
) : (
  <AppRoot router={router} />
);

// Chained so settings have usually hydrated; English resolves without a chunk load.
export const startup = router
  .load()
  .then(whenLocaleReady)
  .then(() => {
    if (reloadScheduled) return;
    if (!chunkLoadFailed) clearChunkReloadGuard();
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>{app}</React.StrictMode>,
    );
  })
  .catch((error: unknown) => {
    if (reloadScheduled) return;
    throw error;
  });
