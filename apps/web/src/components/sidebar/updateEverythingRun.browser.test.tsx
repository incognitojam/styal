import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
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

function setup(): Disposable {
  return {
    [Symbol.dispose]() {
      clearSavedUpdateEverythingResult();
      setUpdateEverythingRun(() => null);
    },
  };
}

const notice = () => (
  <AppAtomRegistryProvider>
    <DesktopUpdateLaunchNotice />
  </AppAtomRegistryProvider>
);

it("restores skipped reasons once after relaunching, including older results without them", async () => {
  using _setup = setup();
  using toast = vi.spyOn(toastManager, "add");
  const savedKey = "t3code:update-everything-result:v1";
  const description = [
    "Skipped Offline machine: not connected.",
    "Skipped Test machine: update did not start.",
  ].join("\n");

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
  await using screen = await render(notice());
  expect(toast).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      type: "warning",
      title: "Updated this app",
      description: <span className="whitespace-pre-line">{description}</span>,
    }),
  );
  expect(window.localStorage.getItem(savedKey)).toBeNull();

  await screen.rerender(null);
  await screen.rerender(notice());
  expect(toast).toHaveBeenCalledTimes(1);

  await screen.rerender(null);
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
  await screen.rerender(notice());
  expect(toast).toHaveBeenCalledTimes(2);
  expect(toast).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: "success", title: "Updated this app" }),
  );
});
