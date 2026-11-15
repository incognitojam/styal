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
 * A badge over the top edge of the enclosing button while the command's modifiers are held,
 * centred on icon buttons so neighbours do not collide and at the right of wider ones. It
 * renders in a portal so header and toolbar clipping cannot cut it off.
 */
export function ShortcutHintBadge(props: {
  command: KeybindingCommand | null;
  context?: Partial<ShortcutMatchContext>;
}) {
  const label = useShortcutHint(props.command, props.context);
  return label === null ? null : <CornerBadge label={label} />;
}

// The window width is part of it because the badge is clamped to the window's right edge.
type BadgeAnchor = { left: number; right: number; top: number; viewportWidth: number };

const remeasureListeners = new Set<() => void>();
let remeasureObserver: MutationObserver | null = null;
let remeasureFrame = 0;

function subscribeToPageChanges(listener: () => void): () => void {
  remeasureListeners.add(listener);
  if (remeasureObserver === null) {
    remeasureObserver = new MutationObserver(() => {
      if (remeasureFrame !== 0) return;
      remeasureFrame = requestAnimationFrame(() => {
        remeasureFrame = 0;
        for (const remeasure of remeasureListeners) remeasure();
      });
    });
    remeasureObserver.observe(document.body, { childList: true, subtree: true });
  }
  return () => {
    remeasureListeners.delete(listener);
    if (remeasureListeners.size > 0) return;
    remeasureObserver?.disconnect();
    remeasureObserver = null;
    cancelAnimationFrame(remeasureFrame);
    remeasureFrame = 0;
  };
}

function sameAnchor(a: BadgeAnchor | null, b: BadgeAnchor | null): boolean {
  return (
    a === b ||
    (a !== null &&
      b !== null &&
      a.left === b.left &&
      a.right === b.right &&
      a.top === b.top &&
      a.viewportWidth === b.viewportWidth)
  );
}

function CornerBadge(props: { label: string }) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [anchor, setAnchor] = useState<BadgeAnchor | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the button in the DOM before paint and again when the page changes, such as a dialog opening over it
  useLayoutEffect(() => {
    const measure = () => {
      const button = anchorRef.current?.parentElement;
      const rect = button?.getBoundingClientRect();
      let next: BadgeAnchor | null = null;
      if (button && rect && rect.width > 0) {
        // A dialog, its backdrop or a popover covering the button means it can't be clicked.
        const hit = document.elementFromPoint(
          (rect.left + rect.right) / 2,
          (rect.top + rect.bottom) / 2,
        );
        if (hit && button.contains(hit)) {
          next = {
            left: rect.left,
            right: rect.right,
            top: rect.top,
            viewportWidth: window.innerWidth,
          };
        }
      }
      // Streaming output changes the page every frame; an unchanged badge should not re-render.
      setAnchor((previous) => (sameAnchor(previous, next) ? previous : next));
    };
    measure();
    return subscribeToPageChanges(measure);
  }, []);
  return (
    <>
      <span ref={anchorRef} aria-hidden className="hidden" />
      {anchor
        ? createPortal(
            <kbd
              aria-hidden
              data-shortcut-hint
              className="pointer-events-none fixed z-[100] inline-flex h-4.5 min-w-4.5 -translate-x-1/2 select-none items-center justify-center rounded border border-border bg-popover px-0.5 font-medium font-sans text-2xs text-popover-foreground shadow-xs"
              style={{
                left: Math.min(
                  Math.max((anchor.left + anchor.right) / 2, anchor.right - 16, 16),
                  window.innerWidth - 20,
                ),
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
