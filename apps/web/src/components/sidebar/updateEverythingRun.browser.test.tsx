import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import { APP_VERSION } from "~/branding";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { toastManager } from "../ui/toast";
import { collectUpdateEverythingResult } from "./updateEverything.logic";
import {
  clearSavedUpdateEverythingResult,
  DesktopUpdateLaunchNotice,
  saveUpdateEverythingResult,
  setUpdateEverythingRun,
} from "./updateEverythingRun";

it("restores skipped reasons once after relaunching, including older results without them", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const toast = vi.spyOn(toastManager, "add");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const savedKey = "t3code:update-everything-result:v1";
  const description = [
    "Skipped Offline machine: not connected.",
    "Skipped Test machine: update did not start.",
  ].join("\n");
  const launch = () =>
    act(async () => {
      root.render(
        <AppAtomRegistryProvider>
          <DesktopUpdateLaunchNotice />
        </AppAtomRegistryProvider>,
      );
    });

  try {
    setUpdateEverythingRun(() => null);
    saveUpdateEverythingResult(
      collectUpdateEverythingResult({
        localVersion: APP_VERSION,
        localFailures: [],
        servers: [{ label: "Test machine", outcome: { status: "skipped" } }],
        providers: [],
        skipped: [{ label: "Offline machine", reason: "not connected" }],
      }),
    );

    // Relaunch loses the in-memory run; only the saved schema can restore the notice.
    setUpdateEverythingRun(() => null);
    await launch();
    expect(toast).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        type: "warning",
        title: "Updated this app",
        description: <span className="whitespace-pre-line">{description}</span>,
      }),
    );
    expect(window.localStorage.getItem(savedKey)).toBeNull();

    await act(async () => root.render(null));
    await launch();
    expect(toast).toHaveBeenCalledTimes(1);

    await act(async () => root.render(null));
    window.localStorage.setItem(
      savedKey,
      JSON.stringify({
        savedAt: Date.now(),
        localVersion: APP_VERSION,
        updatedServers: 0,
        updatedProviders: 0,
        failures: [],
      }),
    );
    await launch();
    expect(toast).toHaveBeenCalledTimes(2);
    expect(toast).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "success", title: "Updated this app" }),
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
    clearSavedUpdateEverythingResult();
    setUpdateEverythingRun(() => null);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
