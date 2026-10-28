import { Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import StarterKit from "@tiptap/starter-kit";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, fakeTimers } from "../../../test/render";
import { showThreadUndoNotice } from "../../hooks/showThreadUndoNotice";
import * as ThreadUndo from "@t3tools/client-runtime/state/thread-undo";
import { registerThreadUndoCommands } from "./ThreadUndoShortcut";

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const { DEFAULT_RESOLVED_KEYBINDINGS } = await import("@t3tools/shared/keybindings");
  return { ...actual, primaryServerKeybindingsAtom: Atom.make(DEFAULT_RESOLVED_KEYBINDINGS) };
});

let undoClaimId = 0;

async function setup() {
  await using stack = new AsyncDisposableStack();
  stack.use(fakeTimers());
  stack.use(vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux"));
  const editorElement = document.body.appendChild(document.createElement("div"));
  stack.defer(() => editorElement.remove());
  const editor = new Editor({
    element: editorElement,
    extensions: [StarterKit],
    // These tests exercise history and shortcuts; jsdom has no caret layout.
    editorProps: { handleScrollToSelection: () => true },
  });
  stack.defer(() => editor.destroy());
  editor.commands.insertContent("Saved synthetic draft.");
  editor.view.dom.focus();
  stack.defer(
    registerThreadUndoCommands({
      threadSidebarShown: () => true,
      sidebarVisible: () => true,
      routeContext: () => ({}),
    }),
  );
  stack.defer(() =>
    act(() => {
      vi.runAllTimers();
    }),
  );

  const fixture = {
    editor,
    threadSettled: true,
    showUndo() {
      const undo = vi.fn(async () => {
        fixture.threadSettled = false;
        return AsyncResult.success(undefined);
      });
      showThreadUndoNotice({
        action: "Settled",
        claim: ThreadUndo.begin("settle", `fixture/thread-${++undoClaimId}`),
        undo,
        failureTitle: "Failed to undo thread action",
      });
      return undo;
    },
  };
  const resources = stack.move();
  return Object.assign(fixture, {
    [Symbol.asyncDispose]: () => resources.disposeAsync(),
  });
}

async function keyDown(key = "z", options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
    ...options,
  });
  await act(() => {
    document.activeElement!.dispatchEvent(event);
  });
  return event;
}

describe("thread Undo with the composer editor", () => {
  it("restores the thread and preserves the draft", async () => {
    await using fixture = await setup();
    const undo = fixture.showUndo();
    await keyDown();
    expect(undo).toHaveBeenCalledOnce();
    expect(fixture.threadSettled).toBe(false);
    expect(fixture.editor.getText()).toBe("Saved synthetic draft.");
  });

  it("hands undo back to the editor after typing", async () => {
    await using fixture = await setup();
    const { editor } = fixture;
    const undo = fixture.showUndo();
    await keyDown("x", { ctrlKey: false });
    editor.view.dispatch(closeHistory(editor.state.tr));
    editor.commands.insertContent(" More text.");
    await keyDown();
    expect(editor.getText()).toBe("Saved synthetic draft.");
    expect(undo).not.toHaveBeenCalled();
  });

  it("hands undo back after an input event without a keypress", async () => {
    await using fixture = await setup();
    const { editor } = fixture;
    const undo = fixture.showUndo();
    editor.view.dispatch(closeHistory(editor.state.tr));
    editor.commands.insertContent(" Pasted text.");
    editor.view.dom.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await keyDown();
    expect(editor.getText()).toBe("Saved synthetic draft.");
    expect(undo).not.toHaveBeenCalled();
  });

  it("consumes held-key repeats after the notice disappears", async () => {
    await using fixture = await setup();
    const { editor } = fixture;
    const undo = fixture.showUndo();
    await keyDown();
    expect((await keyDown("z", { repeat: true })).defaultPrevented).toBe(true);
    expect(undo).toHaveBeenCalledOnce();
    expect(editor.getText()).toBe("Saved synthetic draft.");
    editor.view.dom.dispatchEvent(new KeyboardEvent("keyup", { key: "z", bubbles: true }));
    await keyDown();
    expect(editor.getText()).toBe("");
  });
});
