import { ConfirmDialogHost } from "./components/ConfirmDialogHost";
import { RouterProvider } from "@tanstack/react-router";

import { ElectronBrowserHost } from "./browser/ElectronBrowserHost";
import { ThreadVisitBaselineObserver } from "./components/ThreadVisitBaselineObserver";
import { QuitHoldOverlay } from "./components/QuitHoldOverlay";
import { WebBuildUpdateProvider } from "./components/WebBuildUpdateProvider";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";

/**
 * Owns renderer-wide providers. The Electron browser host intentionally sits
 * outside the router so its webviews survive route transitions, but it must
 * share the same atom registry as routed UI.
 * Confirmation dialogs also have one host here, including on recovery screens;
 * a second host would queue each desktop shutdown request twice.
 */
export function AppRoot({ router }: { readonly router: AppRouter }) {
  return (
    <AppAtomRegistryProvider>
      <WebBuildUpdateProvider>
        <RouterProvider router={router} />
        <ThreadVisitBaselineObserver />
        <ElectronBrowserHost />
        <QuitHoldOverlay />
        <ConfirmDialogHost />
      </WebBuildUpdateProvider>
    </AppAtomRegistryProvider>
  );
}
