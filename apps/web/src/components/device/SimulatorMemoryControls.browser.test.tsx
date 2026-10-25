import type { SimulatorMemoryState } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { resetConfirmDialogForTests } from "~/confirmDialog";
import { ConfirmDialogHost } from "../ConfirmDialogHost";
import { SimulatorMemoryControls } from "./SimulatorMemoryControls";
import type { DeviceControls } from "./useDeviceControls";

const memory: SimulatorMemoryState = {
  supported: true,
  installed: true,
  persistent: true,
  mode: "low-memory",
  disabledServices: 150,
  capabilities: [
    { id: "push", name: "Push notifications", enabled: true },
    { id: "storekit", name: "StoreKit", enabled: true },
    { id: "photos", name: "Photos", enabled: false },
  ],
};

let root: Root;
let container: HTMLDivElement;
const apply = vi.fn<DeviceControls["act"]>();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  resetConfirmDialogForTests();
  apply.mockReset().mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  resetConfirmDialogForTests();
  vi.unstubAllGlobals();
});

function button(label: string) {
  const element = [...document.querySelectorAll("button")].find(
    (element) => element.textContent === label,
  );
  if (!element) throw new Error(`Missing ${label} button`);
  return element;
}

it.each(["low-memory", "standard"] as const)(
  "requires confirmation before restarting to apply %s and leaves the profile unchanged on Cancel",
  async (mode) => {
    await act(async () =>
      root.render(
        <>
          <SimulatorMemoryControls
            memory={memory}
            controls={{
              detail: null,
              pending: false,
              error: null,
              act: apply,
              disabled: false,
              foregroundApp: null,
            }}
          />
          <ConfirmDialogHost />
        </>,
      ),
    );
    const action = mode === "standard" ? "Restore standard services" : "Apply low-memory profile";
    const confirm = mode === "standard" ? "Restart and restore" : "Restart and apply";
    if (mode === "standard") await act(async () => button("Standard").click());
    else {
      const checkbox = [...container.querySelectorAll<HTMLElement>('[role="checkbox"]')].find(
        (element) => element.closest("label")?.textContent === "Photos",
      );
      if (!checkbox) throw new Error("Missing Photos checkbox");
      await act(async () => checkbox.click());
    }

    expect(container.textContent).not.toContain("This restarts the simulator");
    await act(async () => button(action).click());
    expect(apply).not.toHaveBeenCalled();
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain("This restarts the simulator");
    expect(dialog?.textContent).toContain("future boots");
    await act(async () => button("Cancel").click());
    await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).toBeNull());
    expect(apply).not.toHaveBeenCalled();

    await act(async () => button(action).click());
    expect(apply).not.toHaveBeenCalled();
    await act(async () => button(confirm).click());
    expect(apply).toHaveBeenCalledExactlyOnceWith(
      mode === "standard"
        ? { type: "setMemoryProfile", mode }
        : { type: "setMemoryProfile", mode, keepCapabilities: ["push", "storekit", "photos"] },
    );
  },
);
