import type {
  KeybindingCommand,
  KeybindingWhenNode,
  ResolvedKeybindingRule,
  ResolvedKeybindingsConfig,
} from "@t3tools/contracts";

import { formatShortcutLabel, shortcutConflictKey } from "../keybindings";
import {
  buildKeybindingRows,
  commandLabel,
  groupKeybindingRows,
  whenAstToExpression,
} from "./settings/KeybindingsSettings.logic";

export interface ShortcutsOverviewEntry {
  readonly command: KeybindingCommand;
  readonly label: string;
  readonly shortcuts: ReadonlyArray<string>;
}

export interface ShortcutsOverviewGroup {
  readonly id: string;
  readonly title: string;
  readonly entries: ReadonlyArray<ShortcutsOverviewEntry>;
}

/** Only the client is known here; focus and open-panel variables may still become true. */
function canMatchOnClient(
  node: KeybindingWhenNode | undefined,
  isDesktop: boolean,
  expected = true,
): boolean {
  if (!node) return expected;
  switch (node.type) {
    case "identifier":
      if (node.name === "isDesktop") return isDesktop === expected;
      if (node.name === "isWeb") return !isDesktop === expected;
      if (node.name === "true") return expected;
      if (node.name === "false") return !expected;
      return true;
    case "not":
      return canMatchOnClient(node.node, isDesktop, !expected);
    case "and":
    case "or": {
      const left = canMatchOnClient(node.left, isDesktop, expected);
      const right = canMatchOnClient(node.right, isDesktop, expected);
      return (node.type === "and") === expected ? left && right : left || right;
    }
  }
}

/** Later rules win, so an earlier rule for the same keys is dead under the same or a wider `when`. */
function liveBindings(
  keybindings: ResolvedKeybindingsConfig,
  platform: string,
  isDesktop: boolean,
): ReadonlyArray<ResolvedKeybindingRule> {
  const claimedWhens = new Map<string, Set<string>>();
  return keybindings.toReversed().filter((binding) => {
    if (!canMatchOnClient(binding.whenAst, isDesktop)) return false;
    const key = shortcutConflictKey(binding.shortcut, platform);
    const when = whenAstToExpression(binding.whenAst);
    const claimed = claimedWhens.get(key) ?? new Set();
    if (claimed.has("") || claimed.has(when)) return false;
    claimedWhens.set(key, claimed.add(when));
    return true;
  });
}

export function buildShortcutsOverview(
  keybindings: ResolvedKeybindingsConfig,
  options: { readonly platform: string; readonly isDesktop: boolean },
): ReadonlyArray<ShortcutsOverviewGroup> {
  const rows = buildKeybindingRows(liveBindings(keybindings, options.platform, options.isDesktop));
  return groupKeybindingRows(rows).map((group) => {
    const shortcutsByCommand = new Map<KeybindingCommand, Set<string>>();
    for (const row of group.rows) {
      const shortcuts = shortcutsByCommand.get(row.command) ?? new Set();
      shortcutsByCommand.set(
        row.command,
        shortcuts.add(formatShortcutLabel(row.binding.shortcut, options.platform)),
      );
    }
    return {
      id: group.id,
      title: group.title,
      entries: [...shortcutsByCommand].map(([command, shortcuts]) => ({
        command,
        label: commandLabel(command),
        shortcuts: [...shortcuts],
      })),
    };
  });
}
