import type {
  ClientSettings,
  KeybindingCommand,
  KeybindingWhenNode,
  ResolvedKeybindingRule,
  ResolvedKeybindingsConfig,
} from "@t3tools/contracts";

import { formatShortcutLabel, shortcutConflictKey, shortcutForContext } from "../keybindings";
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

/** The send setting moves Mod+Enter's alternate send to Mod+Shift+Enter, always or for multiline. */
function shortcutsForBinding(
  binding: ResolvedKeybindingRule,
  sendShortcut: ClientSettings["sendShortcut"],
) {
  const requiring = shortcutForContext(binding, { composerRequiresModifier: true });
  if (sendShortcut === "enter") return [binding.shortcut];
  return sendShortcut === "mod-enter" ? [requiring] : [binding.shortcut, requiring];
}

const JUMP_COMMAND = /^(.+\.jump)\.(\d)$/;

/** One row for a run of jump commands, unless the keys were rebound out of step with the digits. */
function collapseJumpRun(
  run: ReadonlyArray<ShortcutsOverviewEntry>,
): ShortcutsOverviewEntry | null {
  const first = run[0];
  const last = run.at(-1);
  if (!first || !last || run.length < 2) return null;
  const digit = (entry: ShortcutsOverviewEntry) => Number(entry.command.at(-1));
  if (digit(last) - digit(first) + 1 !== run.length) return null;
  const keyPrefix = first.shortcuts[0]?.slice(0, -1);
  const inStep = run.every(
    (entry) => entry.shortcuts.length === 1 && entry.shortcuts[0] === `${keyPrefix}${digit(entry)}`,
  );
  if (!inStep) return null;
  const range = `${digit(first)}–${digit(last)}`;
  return {
    command: first.command,
    label: first.label.replace(/\d$/, range),
    shortcuts: [`${keyPrefix}${range}`],
  };
}

function collapseJumps(
  entries: ReadonlyArray<ShortcutsOverviewEntry>,
): ReadonlyArray<ShortcutsOverviewEntry> {
  const jumpFamily = (entry: ShortcutsOverviewEntry) => JUMP_COMMAND.exec(entry.command)?.[1];
  return entries.flatMap((entry) => {
    const family = jumpFamily(entry);
    if (!family) return [entry];
    const run = entries.filter((candidate) => jumpFamily(candidate) === family);
    const collapsed = collapseJumpRun(run);
    if (!collapsed) return [entry];
    return entry === run[0] ? [collapsed] : [];
  });
}

export function buildShortcutsOverview(
  keybindings: ResolvedKeybindingsConfig,
  options: {
    readonly platform: string;
    readonly isDesktop: boolean;
    readonly sendShortcut: ClientSettings["sendShortcut"];
  },
): ReadonlyArray<ShortcutsOverviewGroup> {
  const rows = buildKeybindingRows(liveBindings(keybindings, options.platform, options.isDesktop));
  return groupKeybindingRows(rows).map((group) => {
    const shortcutsByCommand = new Map<KeybindingCommand, Set<string>>();
    for (const row of group.rows) {
      const shortcuts = shortcutsByCommand.get(row.command) ?? new Set();
      for (const shortcut of shortcutsForBinding(row.binding, options.sendShortcut)) {
        shortcuts.add(formatShortcutLabel(shortcut, options.platform));
      }
      shortcutsByCommand.set(row.command, shortcuts);
    }
    return {
      id: group.id,
      title: group.title,
      entries: collapseJumps(
        [...shortcutsByCommand].map(([command, shortcuts]) => ({
          command,
          label: commandLabel(command),
          shortcuts: [...shortcuts],
        })),
      ),
    };
  });
}
