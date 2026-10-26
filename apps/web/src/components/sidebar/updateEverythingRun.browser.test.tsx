import { expect, it, vi } from "vite-plus/test";

import { APP_VERSION } from "~/branding";
import { toastManager } from "../ui/toast";
import { collectUpdateEverythingResult } from "./updateEverything.logic";
import {
  clearSavedUpdateEverythingResult,
  saveUpdateEverythingResult,
  setUpdateEverythingRun,
  startDesktopUpdateLaunchNotice,
} from "./updateEverythingRun";

function setup(): Disposable {
  return {
    [Symbol.dispose]() {
      clearSavedUpdateEverythingResult();
      setUpdateEverythingRun(() => null);
    },
  };
}

function launch(): Disposable {
  return { [Symbol.dispose]: startDesktopUpdateLaunchNotice() };
}

it("restores skipped reasons once after relaunching, including older results without them", async () => {
  using _setup = setup();
  using toast = vi.spyOn(toastManager, "add");
  const now = Date.parse("2026-07-02T00:00:00.000Z");
  using _now = vi.spyOn(Date, "now").mockReturnValue(now);
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
  const first = launch();
  expect(toast).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      type: "warning",
      title: "Updated this app",
      description: <span className="whitespace-pre-line">{description}</span>,
    }),
  );
  expect(window.localStorage.getItem(savedKey)).toBeNull();

  first[Symbol.dispose]();
  launch()[Symbol.dispose]();
  expect(toast).toHaveBeenCalledTimes(1);

  window.localStorage.setItem(
    savedKey,
    JSON.stringify({
      savedAt: now,
      localVersion: APP_VERSION,
      updatedServers: 0,
      updatedProviders: 0,
      failures: [],
    }),
  );
  using _relaunch = launch();
  expect(toast).toHaveBeenCalledTimes(2);
  expect(toast).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: "success", title: "Updated this app" }),
  );
});
