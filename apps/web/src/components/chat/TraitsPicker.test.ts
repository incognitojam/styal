import { describe, expect, it } from "vite-plus/test";
import { traitsTriggerTooltip } from "./TraitsPicker";

describe("traitsTriggerTooltip", () => {
  it("names the menu and its shortcut while the button shows its values", () => {
    expect(
      traitsTriggerTooltip({ label: "Medium · 1M", iconOnly: false, shortcutLabel: "⇧⌘E" }),
    ).toBe("Effort and options · ⇧⌘E");
  });

  it("shows the values when the button collapses to its icon", () => {
    expect(
      traitsTriggerTooltip({ label: "Medium Fast · 1M", iconOnly: true, shortcutLabel: "⇧⌘E" }),
    ).toBe("Medium Fast · 1M · ⇧⌘E");
  });

  it("leaves out an unbound shortcut", () => {
    expect(traitsTriggerTooltip({ label: "Medium", iconOnly: false })).toBe("Effort and options");
  });
});
