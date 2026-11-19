import { describe, expect, it } from "vite-plus/test";

import {
  shortcutModifierStateAfterKeyboardEvent,
  shortcutModifierStore,
  type ShortcutModifierState,
} from "./shortcutModifierState";

const emptyState = (): ShortcutModifierState => ({
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
});

function keyboardEventLike(type: "keydown" | "keyup", init: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    type,
    key: "",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...init,
  } as KeyboardEvent;
}

describe("shortcutModifierState", () => {
  it("tracks bare modifier keydown and keyup events explicitly", () => {
    let state = emptyState();
    state = shortcutModifierStateAfterKeyboardEvent(
      state,
      keyboardEventLike("keydown", {
        key: "Meta",
        metaKey: false,
      }),
    );
    expect(state).toEqual({
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    });

    state = shortcutModifierStateAfterKeyboardEvent(
      state,
      keyboardEventLike("keydown", {
        key: "Shift",
        metaKey: true,
        shiftKey: false,
      }),
    );
    expect(state).toEqual({
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
    });

    state = shortcutModifierStateAfterKeyboardEvent(
      state,
      keyboardEventLike("keyup", {
        key: "Meta",
        metaKey: true,
        shiftKey: true,
      }),
    );
    expect(state).toEqual({
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
    });

    state = shortcutModifierStateAfterKeyboardEvent(
      state,
      keyboardEventLike("keyup", {
        key: "Shift",
        shiftKey: true,
      }),
    );
    expect(state).toEqual({
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    });
  });

  it("ignores poisoned modifier flags on non-modifier keys", () => {
    // Synthetic dictation paste can poison later real key events with metaKey=true.
    const state = shortcutModifierStateAfterKeyboardEvent(
      emptyState(),
      keyboardEventLike("keydown", { key: "Enter", metaKey: true }),
    );
    expect(state).toEqual(emptyState());
  });

  it.each(["a", "Shift", "Control", "Alt"])(
    "clears a held modifier when %s reports it released",
    (key) => {
      const heldMeta: ShortcutModifierState = {
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      };
      const state = shortcutModifierStateAfterKeyboardEvent(
        heldMeta,
        keyboardEventLike("keyup", { key, metaKey: false }),
      );
      expect(state).toEqual(emptyState());
    },
  );

  it.each(["pointermove", "pointerdown", "focus", "visibilitychange"])(
    "recovers from a missed modifier release on %s",
    (type) => {
      const unsubscribe = shortcutModifierStore.subscribe(() => {});
      try {
        for (const key of ["Meta", "Control"]) {
          window.dispatchEvent(new KeyboardEvent("keydown", { key }));
          expect(shortcutModifierStore.getSnapshot()).toMatchObject({
            [key === "Meta" ? "metaKey" : "ctrlKey"]: true,
          });

          if (type.startsWith("pointer")) {
            const held = shortcutModifierStore.getSnapshot();
            window.dispatchEvent(new PointerEvent(type, { metaKey: true, ctrlKey: true }));
            expect(shortcutModifierStore.getSnapshot()).toBe(held);
            window.dispatchEvent(new PointerEvent(type));
          } else {
            (type === "visibilitychange" ? document : window).dispatchEvent(new Event(type));
          }
          expect(shortcutModifierStore.getSnapshot()).toEqual(emptyState());
          if (type.startsWith("pointer")) {
            window.dispatchEvent(new PointerEvent(type, { metaKey: true, ctrlKey: true }));
            expect(shortcutModifierStore.getSnapshot()).toEqual(emptyState());
          }
        }
      } finally {
        unsubscribe();
      }
    },
  );
});
