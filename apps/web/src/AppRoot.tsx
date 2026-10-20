import { ConfirmDialogHost } from "./components/ConfirmDialogHost";
import { RouterProvider } from "@tanstack/react-router";
import { useEffect } from "react";

import { subscribeComposerDraftModelReconciliation } from "./composerDraftStore";
import { environmentThreadShells } from "./state/threads";
import { environmentShell } from "./state/shell";

import { BrowserProfileReporter } from "./browser/BrowserProfileReporter";
import { ElectronBrowserHost } from "./browser/ElectronBrowserHost";
import { ClientSettingsSnapshotReporter } from "./components/ClientSettingsSnapshotReporter";
import { ThreadVisitBaselineObserver } from "./components/ThreadVisitBaselineObserver";
import { QuitHoldOverlay } from "./components/QuitHoldOverlay";
import { WebBuildUpdateProvider } from "./components/WebBuildUpdateProvider";
import { appAtomRegistry, AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";

/**
 * Owns renderer-wide providers. The Electron browser host intentionally sits
 * outside the router so its webviews survive route transitions, but it must
 * share the same atom registry as routed UI.
 * Confirmation dialogs also have one host here, including on recovery screens;
 * a second host would queue each desktop shutdown request twice.
 */
export function AppRoot({ router }: { readonly router: AppRouter }) {
  useEffect(
    () =>
      subscribeComposerDraftModelReconciliation({
        registry: appAtomRegistry,
        threadShellAtom: environmentThreadShells.threadShellAtom,
        threadRefsAtom: environmentThreadShells.threadRefsAtom,
        shellStateAtom: environmentShell.stateAtom,
      }),
    [],
  );
  return (
    <AppAtomRegistryProvider>
      <WebBuildUpdateProvider>
        <RouterProvider router={router} />
        <ThreadVisitBaselineObserver />
        <ElectronBrowserHost />
        <BrowserProfileReporter />
        <ClientSettingsSnapshotReporter />
        <QuitHoldOverlay />
        <ConfirmDialogHost />
      </WebBuildUpdateProvider>
    </AppAtomRegistryProvider>
  );
}
