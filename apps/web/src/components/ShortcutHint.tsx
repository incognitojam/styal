import type { KeybindingCommand } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { deadlineAfter } from "@t3tools/client-runtime/clock";
import {
  createContext,
  use,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { isElectron } from "../env";
import { useDeadlinePassed } from "../hooks/useDeadline";
import { type ShortcutMatchContext, shortcutHintLabelForModifiers } from "../keybindings";
import { type ShortcutModifierState, useShortcutModifierState } from "../shortcutModifierState";
import { isTerminalFocused, subscribeToTerminalFocusChanges } from "../lib/terminalFocus";
import { primaryServerKeybindingsAtom } from "../state/server";
import { THREAD_JUMP_HINT_SHOW_DELAY_MS } from "./Sidebar.logic";

const HeldShortcutModifiersContext = createContext<ShortcutModifierState | null>(null);

/**
 * Publishes the held modifiers once Cmd or Ctrl has been held for the hint delay,
 * so buttons can show the shortcuts that need exactly those modifiers.
 */
export function ShortcutHintProvider(props: { children: ReactNode }) {
  const modifiers = useShortcutModifierState();
  // Ghostty can write keys to the shell before window shortcuts run.
  const terminalFocused = useSyncExternalStore(
    subscribeToTerminalFocusChanges,
    isTerminalFocused,
    () => false,
  );
  const holding = (modifiers.metaKey || modifiers.ctrlKey) && !terminalFocused;
  const visible = useHeldForHintDelay(holding);
  return (
    <HeldShortcutModifiersContext value={visible && holding ? modifiers : null}>
      {props.children}
    </HeldShortcutModifiersContext>
  );
}

/** True once `holding` has stayed true for the hint delay, so a quick shortcut never flashes hints. */
function useHeldForHintDelay(holding: boolean): boolean {
  const [showAt, setShowAt] = useState<number | null>(null);
  // The clock is read inside the updater: the compiler caches a bare clock read
  // in render once per instance, so a second hold would reuse the first deadline.
  if (holding !== (showAt !== null)) {
    setShowAt(holding ? () => deadlineAfter(THREAD_JUMP_HINT_SHOW_DELAY_MS) : null);
  }
  return useDeadlinePassed(showAt);
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
 * A badge over the top edge of the enclosing button while the command's modifiers are held. It
 * renders in a portal so header and toolbar clipping cannot cut it off.
 */
export function ShortcutHintBadge(props: {
  command: KeybindingCommand | null;
  context?: Partial<ShortcutMatchContext>;
  /** Pins the badge to the left of a wide control, for a second shortcut on the same control. */
  side?: "start";
}) {
  const label = useShortcutHint(props.command, props.context);
  return label === null || !supportsAnchorPositioning ? null : (
    <CornerBadge label={label} side={props.side} />
  );
}

// Browsers without CSS anchor positioning, or without hiding a badge whose button is scrolled
// away (Safari before 26.2), show no badges rather than misplaced ones.
const supportsAnchorPositioning =
  typeof CSS !== "undefined" &&
  CSS.supports("anchor-name", "--shortcut-hint") &&
  // "always" because the spec is renaming anchors-visible to anchor-visible.
  CSS.supports("position-visibility", "always");

// A button can carry several badges, such as a model and an effort shortcut, so names are listed.
function anchorNamesOf(element: HTMLElement): string[] {
  return element.style
    .getPropertyValue("anchor-name")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "" && name !== "none");
}

function setAnchorNames(element: HTMLElement, names: string[]) {
  if (names.length === 0) element.style.removeProperty("anchor-name");
  else element.style.setProperty("anchor-name", names.join(", "));
}

function CornerBadge(props: { label: string; side: "start" | undefined }) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const anchorName = `--shortcut-hint-${useId().replace(/[^\w-]/g, "")}`;
  const [blocked, setBlocked] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- names the button as the badge's CSS anchor and follows the page attributes that mark it unreachable
  useLayoutEffect(() => {
    const button = anchorRef.current?.parentElement;
    if (!button) return;
    setAnchorNames(button, [...anchorNamesOf(button), anchorName]);
    // A modal dialog hides the rest of the page with aria-hidden, and the app makes views behind
    // Settings and the command palette inert. Streaming adds elements without changing either.
    const check = () => setBlocked(button.closest('[inert], [aria-hidden="true"]') !== null);
    check();
    const attributes = new MutationObserver(check);
    attributes.observe(document.body, {
      attributes: true,
      attributeFilter: ["inert", "aria-hidden"],
      subtree: true,
    });
    return () => {
      attributes.disconnect();
      setAnchorNames(
        button,
        anchorNamesOf(button).filter((name) => name !== anchorName),
      );
    };
  }, [anchorName]);
  return (
    <>
      <span ref={anchorRef} aria-hidden className="hidden" />
      {blocked
        ? null
        : createPortal(
            <kbd
              aria-hidden
              data-shortcut-hint
              className="pointer-events-none fixed z-[100] inline-flex h-4.5 min-w-4.5 -translate-x-1/2 select-none items-center justify-center rounded border border-border bg-popover px-0.5 font-medium font-sans text-2xs text-popover-foreground shadow-xs"
              // The browser keeps the badge on its button as layout changes and hides it while the
              // button is scrolled out of view. Centred on icon buttons, at one end of wide ones,
              // at least 2px from the window top, and far off screen with no laid-out button.
              style={{
                positionAnchor: anchorName,
                left:
                  props.side === "start"
                    ? "min(max(min(anchor(center), calc(anchor(left) + 16px)), 16px), calc(100vw - 20px))"
                    : "min(max(anchor(center), calc(anchor(right) - 16px), 16px), calc(100vw - 20px))",
                top: "max(calc(anchor(top, -9999px) - 6px), min(2px, calc(anchor(top, -9999px) + 5000px)))",
              }}
            >
              {props.label}
            </kbd>,
            document.body,
          )}
    </>
  );
}
