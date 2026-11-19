import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "Shortcut hints clear on pointer movement after a swallowed modifier release",
  WEB,
  async ({ t3, app, screen, browser }) => {
    await t3.project("shortcut-demo");
    await t3.open();
    await expect(screen.getByRole("button", "Add project")).toBeVisible();
    // The overlay's missing keyup is simulated; pointer recovery runs in the real app.
    await browser.evaluate(`() => {
      document.activeElement?.blur();
      const mac = /Mac/i.test(navigator.platform);
      window.dispatchEvent(new KeyboardEvent("keydown", {
        key: mac ? "Meta" : "Control",
        metaKey: mac,
        ctrlKey: !mac,
      }));
      return null;
    }`);
    const hints = () =>
      browser.evaluate<number>('document.querySelectorAll("[data-shortcut-hint]").length');
    await expect.poll(hints).toBeGreaterThan(0);
    await browser.mouse.move(600, 300);
    await app.screenshot("after-missed-release");
    await expect.poll(hints).toBe(0);
  },
);
