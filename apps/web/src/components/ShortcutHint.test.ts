import { expect, it } from "vite-plus/test";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { shortcutHintLabelForModifiers } from "./ShortcutHint";
it("uses every held modifier and allows shortcuts needing another modifier", () => {
  const held = { metaKey: true, ctrlKey: false, altKey: false, shiftKey: false };
  const options = { platform: "MacIntel" };
  expect(
    shortcutHintLabelForModifiers(
      held,
      DEFAULT_RESOLVED_KEYBINDINGS,
      "modelPicker.toggle",
      options,
    ),
  ).toBe("⇧⌘M");
  expect(
    shortcutHintLabelForModifiers(
      { ...held, shiftKey: true },
      DEFAULT_RESOLVED_KEYBINDINGS,
      "terminal.toggle",
      options,
    ),
  ).toBeNull();
  expect(
    shortcutHintLabelForModifiers(
      { ...held, altKey: true },
      DEFAULT_RESOLVED_KEYBINDINGS,
      "modelPicker.toggle",
      options,
    ),
  ).toBeNull();
});
