import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "Project settings opens a dialog over the project page",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const project = await t3.project("orchard");
    await t3.thread({ project, title: "Plan the orchard", messages: ["Hello"] });
    await t3.open();
    await expect(screen.getByRole("button", "Add project")).toBeVisible({ timeout: 120_000 });
    await app.open("/settings/labs");
    await expect(screen.getByRole("switch", "Project coordinators")).toBeVisible({
      timeout: 120_000,
    });
    await screen.getByRole("switch", "Project coordinators").tap();
    await screen.getByRole("button", "Close").tap();
    await screen.getByText("orchard", { exact: true }).first().tap();
    await screen.getByRole("button", "orchard", { exact: true }).secondaryTap();
    await screen.getByRole("menuitem", "Project settings").tap();
    try {
      await expect(screen.getByRole("dialog", "Settings")).toBeVisible();
    } finally {
      await app.screenshot("project-settings");
    }
    await expect(screen.getByRole("button", "Project scope: orchard")).toBeVisible();
    await expect
      .poll(() =>
        browser.evaluate<boolean>(
          'document.querySelector("[data-testid=project-chat-header]") !== null',
        ),
      )
      .toBe(true);
    await screen.getByRole("button", "Close", { exact: true }).tap();
    await expect(screen.getByRole("button", "Project settings", { exact: true })).toBeVisible();
  },
);
