import { useAtomValue } from "@effect/atom-react";
import { useEffect, useRef } from "react";

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
import { primaryServerKeybindingsAtom } from "../../state/server";
import { useSidebarVisibility } from "../ui/sidebar";

const MODIFIER_KEYS = new Set(["Alt", "Control", "Meta", "Shift"]);

// Undoes the thread actions in the sidebar's notice. Mounted wherever the
// thread sidebar can show; Settings replaces it. Listens in the capture phase
// so mod+z reaches it before the composer's own undo handler consumes the key.
export function ThreadUndoShortcut() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  // A collapsed sidebar hides the notice, so text fields keep their own undo.
  const noticeVisible = useSidebarVisibility();

  const heldUndoKey = useRef<string | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      // Keep repeats consumed after the notice disappears, until keyup.
      if (event.repeat && heldUndoKey.current === event.key.toLowerCase()) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          previewFocus: isPreviewFocused(),
          editableFocus:
            isEditableFocused(event.target) && !(noticeVisible && threadUndoClaimsShortcut()),
          modelPickerOpen: isModelPickerOpen(),
        },
      });
      if (command !== "thread.undo") {
        if (!MODIFIER_KEYS.has(event.key)) releaseThreadUndoShortcut();
        return;
      }
      if (isCommandPaletteOpen() || isModelPickerOpen()) return;
      if (event.repeat) return;
      if (undoLatestThreadAction()) {
        heldUndoKey.current = event.key.toLowerCase();
        event.preventDefault();
        event.stopPropagation();
      }
    };
    // Pastes from a menu, dictation and drops edit text without a keypress.
    const onInput = () => releaseThreadUndoShortcut();
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === heldUndoKey.current) heldUndoKey.current = null;
    };
    const onBlur = () => {
      heldUndoKey.current = null;
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("input", onInput, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("input", onInput, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [keybindings, noticeVisible]);

  return null;
}
