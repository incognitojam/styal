import type { ShortcutMatchContext } from "../../keybindings";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import {
  releaseThreadUndoShortcut,
  threadUndoClaimsShortcut,
  undoLatestThreadAction,
} from "../../hooks/showThreadUndoNotice";
import { resolveShortcutCommand } from "../../keybindings";
import { isEditableFocused } from "../../lib/editableFocus";
import { isPreviewFocused } from "../../lib/previewFocus";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { isModelPickerOpen } from "../../modelPickerVisibility";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { registerCommands } from "../../shortcuts/dispatcher";
import { primaryServerKeybindingsAtom } from "../../state/server";

const MODIFIER_KEYS = new Set(["Alt", "Control", "Meta", "Shift"]);

export interface ThreadUndoCommandsOptions {
  /** False while Settings or Usage is open; they own mod+z. */
  readonly threadSidebarShown: () => boolean;
  /** A collapsed sidebar hides the notice, so text fields keep their own undo. */
  readonly sidebarVisible: () => boolean;
  readonly routeContext: () => Partial<ShortcutMatchContext>;
}

// Undoes the thread actions in the sidebar's notice. Captured so mod+z reaches
// it before the composer's own undo handler consumes the key.
export function registerThreadUndoCommands(options: ThreadUndoCommandsOptions): () => void {
  let heldUndoKey: string | null = null;
  const unregister = registerCommands(
    {},
    {
      capture: true,
      when: options.threadSidebarShown,
      onKeyDown: (event) => {
        if (event.isComposing) return false;
        // Keep repeats consumed after the notice disappears, until keyup.
        if (event.repeat && heldUndoKey === event.key.toLowerCase()) {
          event.preventDefault();
          event.stopPropagation();
          return true;
        }
        const command = resolveShortcutCommand(
          event,
          appAtomRegistry.get(primaryServerKeybindingsAtom),
          {
            context: {
              terminalFocus: isTerminalFocused(),
              previewFocus: isPreviewFocused(),
              ...options.routeContext(),
              editableFocus:
                isEditableFocused(event.target) &&
                !(options.sidebarVisible() && threadUndoClaimsShortcut()),
              modelPickerOpen: isModelPickerOpen(),
            },
          },
        );
        if (command !== "thread.undo") {
          if (!MODIFIER_KEYS.has(event.key)) releaseThreadUndoShortcut();
          return false;
        }
        if (isCommandPaletteOpen() || isModelPickerOpen()) return false;
        if (event.repeat) return false;
        if (!undoLatestThreadAction()) return false;
        heldUndoKey = event.key.toLowerCase();
        event.preventDefault();
        event.stopPropagation();
        return true;
      },
    },
  );
  // Pastes from a menu, dictation and drops edit text without a keypress.
  const onInput = () => {
    if (options.threadSidebarShown()) releaseThreadUndoShortcut();
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (event.key.toLowerCase() === heldUndoKey) heldUndoKey = null;
  };
  const onBlur = () => {
    heldUndoKey = null;
  };
  window.addEventListener("input", onInput, true);
  window.addEventListener("keyup", onKeyUp, true);
  window.addEventListener("blur", onBlur);
  return () => {
    unregister();
    window.removeEventListener("input", onInput, true);
    window.removeEventListener("keyup", onKeyUp, true);
    window.removeEventListener("blur", onBlur);
  };
}
