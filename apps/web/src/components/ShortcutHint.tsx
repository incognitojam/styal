import type { KeybindingCommand } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { createContext, use, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { isElectron } from "../env";
import { useTerminalFocus } from "../hooks/useTerminalFocus";
import { type ShortcutMatchContext, shortcutHintLabelForModifiers } from "../keybindings";
import { type ShortcutModifierState, useShortcutModifierState } from "../shortcutModifierState";
import { primaryServerKeybindingsAtom } from "../state/server";
import { useThreadJumpHintsVisible } from "./Sidebar.logic";
import { Kbd } from "./ui/kbd";

const HeldShortcutModifiersContext = createContext<ShortcutModifierState | null>(null);

/**
 * Publishes the held modifiers once Cmd or Ctrl has been held for the hint delay,
 * so buttons can show the shortcuts that need exactly those modifiers.
 */
export function ShortcutHintProvider(props: { children: ReactNode }) {
  const modifiers = useShortcutModifierState();
  // Ghostty can write keys to the shell before window shortcuts run.
  const terminalFocused = useTerminalFocus();
  const holding = (modifiers.metaKey || modifiers.ctrlKey) && !terminalFocused;
  const visible = useThreadJumpHintsVisible(holding);
  return (
    <HeldShortcutModifiersContext value={visible && holding ? modifiers : null}>
      {props.children}
    </HeldShortcutModifiersContext>
  );
}

/** The command's shortcut label while its modifiers are held, otherwise null. */
function useShortcutHint(
  command: KeybindingCommand | null,
  context?: Partial<ShortcutMatchContext>,
): string | null {
  const modifiers = use(HeldShortcutModifiersContext);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  if (modifiers === null || command === null) return null;
  return shortcutHintLabelForModifiers(modifiers, keybindings, command, {
    context: { isWeb: !isElectron, isDesktop: isElectron, ...context },
  });
}

/**
 * A badge over the top-right corner of the enclosing button while the command's
 * modifiers are held. It renders in a portal so header and toolbar clipping
 * cannot cut it off.
 */
export function ShortcutHintBadge(props: {
  command: KeybindingCommand | null;
  context?: Partial<ShortcutMatchContext>;
}) {
  const label = useShortcutHint(props.command, props.context);
  return label === null ? null : <CornerBadge label={label} />;
}

function CornerBadge(props: { label: string }) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the button in the DOM before paint to place the portalled badge
  useLayoutEffect(() => {
    const rect = anchorRef.current?.parentElement?.getBoundingClientRect();
    setAnchor(rect && rect.width > 0 ? rect : null);
  }, []);
  return (
    <>
      <span ref={anchorRef} aria-hidden className="hidden" />
      {anchor
        ? createPortal(
            <kbd
              aria-hidden
              data-shortcut-hint
              className="pointer-events-none fixed z-[100] inline-flex h-4.5 min-w-4.5 -translate-x-1/2 select-none items-center justify-center rounded border border-border bg-popover px-1 font-medium font-sans text-2xs text-popover-foreground shadow-xs"
              style={{
                left: Math.min(Math.max(anchor.right - 4, 16), window.innerWidth - 20),
                top: Math.max(anchor.top - 6, 2),
              }}
            >
              {props.label}
            </kbd>,
            document.body,
          )
        : null}
    </>
  );
}

/** Shows the command's shortcut in place of a labelled control's icon while its modifiers are held. */
export function ShortcutHintSlot(props: {
  command: KeybindingCommand | null;
  context?: Partial<ShortcutMatchContext>;
  children: ReactNode;
}) {
  const label = useShortcutHint(props.command, props.context);
  return label === null ? (
    props.children
  ) : (
    <Kbd aria-hidden data-shortcut-hint>
      {label}
    </Kbd>
  );
}
