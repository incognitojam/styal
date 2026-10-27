import { ConfirmDialogHost } from "./components/ConfirmDialogHost";
import { RouterProvider } from "@tanstack/react-router";

import { ElectronBrowserHost } from "./browser/ElectronBrowserHost";
import { ClientSettingsSnapshotReporter } from "./components/ClientSettingsSnapshotReporter";
import { ThreadVisitBaselineObserver } from "./components/ThreadVisitBaselineObserver";
import { QuitHoldOverlay } from "./components/QuitHoldOverlay";
import { WebBuildUpdateProvider } from "./components/WebBuildUpdateProvider";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";

// Keep webviews outside the router but inside its atom registry so route changes preserve them.
// Confirmation dialogs have one host here; a second would queue each desktop shutdown request twice.
export function AppRoot({ router }: { readonly router: AppRouter }) {
  return (
    <AppAtomRegistryProvider>
      <WebBuildUpdateProvider>
        <RouterProvider router={router} />
        <ThreadVisitBaselineObserver />
        <ElectronBrowserHost />
        <ClientSettingsSnapshotReporter />
        <QuitHoldOverlay />
        <ConfirmDialogHost />
      </WebBuildUpdateProvider>
    </AppAtomRegistryProvider>
  );
}
