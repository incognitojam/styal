import { describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { useRef } from "react";

import { render } from "../../test/render";
import { ComposerHandleContext, type ComposerHandleRef } from "../composerHandleContext";
import { ShortcutsOverview, useShortcutsOverviewStore } from "./ShortcutsOverview";

function ChatWithOverview() {
  const inputRef = useRef<HTMLInputElement>(null);
  const composer = { focusAtEnd: () => inputRef.current?.focus() };
  const handle = { current: composer } as unknown as ComposerHandleRef;
  return (
    <ComposerHandleContext value={handle}>
      <button type="button">Settings</button>
      <input aria-label="Composer" ref={inputRef} />
      <ShortcutsOverview />
    </ComposerHandleContext>
  );
}

describe("ShortcutsOverview", () => {
  it("hands focus to the composer when Escape closes it", async () => {
    useShortcutsOverviewStore.setState({ open: false });
    await using _screen = await render(<ChatWithOverview />);
    (page.getByRole("button", { name: "Settings" }).element() as HTMLElement).focus();

    useShortcutsOverviewStore.setState({ open: true });
    await expect.element(page.getByText("Keyboard shortcuts")).toBeVisible();
    await userEvent.keyboard("{Escape}");

    await expect.element(page.getByLabelText("Composer")).toHaveFocus();
  });
});
