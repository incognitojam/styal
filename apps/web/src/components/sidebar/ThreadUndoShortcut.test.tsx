// @vitest-environment jsdom

import { Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import StarterKit from "@tiptap/starter-kit";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { AsyncResult } from "effect/unstable/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { showThreadUndoNotice } from "../../hooks/showThreadUndoNotice";
import * as ThreadUndo from "../../hooks/threadUndo";
import { ThreadUndoShortcut } from "./ThreadUndoShortcut";

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => DEFAULT_RESOLVED_KEYBINDINGS }));
vi.mock("../../state/server", () => ({ primaryServerKeybindingsAtom: {} }));
vi.mock("../ui/sidebar", () => ({ useSidebarVisibility: () => true }));

let root: Root;
let container: HTMLDivElement;
let editor: Editor;
let threadSettled: boolean;
let undoClaimId = 0;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux");
  threadSettled = true;
  container = document.createElement("div");
  const editorElement = document.createElement("div");
  document.body.append(container, editorElement);
  root = createRoot(container);
  editor = new Editor({
    element: editorElement,
    extensions: [StarterKit],
    // These tests exercise history and shortcuts; jsdom has no caret layout.
    editorProps: { handleScrollToSelection: () => true },
  });
  editor.commands.insertContent("Saved synthetic draft.");
  editor.view.dom.focus();
  act(() => root.render(<ThreadUndoShortcut />));
});

afterEach(() => {
  act(() => {
    vi.runAllTimers();
    root.unmount();
  });
  editor.destroy();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function showUndo() {
  const undo = vi.fn(async () => {
    threadSettled = false;
    return AsyncResult.success(undefined);
  });
  showThreadUndoNotice({
    action: "Settled",
    claim: ThreadUndo.begin("settle", `fixture/thread-${++undoClaimId}`),
    undo,
    failureTitle: "Failed to undo thread action",
  });
  return undo;
}

function keyDown(key = "z", options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
    ...options,
  });
  act(() => {
    document.activeElement!.dispatchEvent(event);
  });
  return event;
}

describe("thread Undo with the composer editor", () => {
  it("restores the thread and preserves the draft", () => {
    const undo = showUndo();
    keyDown();
    expect(undo).toHaveBeenCalledOnce();
    expect(threadSettled).toBe(false);
    expect(editor.getText()).toBe("Saved synthetic draft.");
  });

  it("hands undo back to the editor after typing", () => {
    const undo = showUndo();
    keyDown("x", { ctrlKey: false });
    editor.view.dispatch(closeHistory(editor.state.tr));
    editor.commands.insertContent(" More text.");
    keyDown();
    expect(editor.getText()).toBe("Saved synthetic draft.");
    expect(undo).not.toHaveBeenCalled();
  });

  it("hands undo back after an input event without a keypress", () => {
    const undo = showUndo();
    editor.view.dispatch(closeHistory(editor.state.tr));
    editor.commands.insertContent(" Pasted text.");
    editor.view.dom.dispatchEvent(new InputEvent("input", { bubbles: true }));
    keyDown();
    expect(editor.getText()).toBe("Saved synthetic draft.");
    expect(undo).not.toHaveBeenCalled();
  });

  it("consumes held-key repeats after the notice disappears", () => {
    const undo = showUndo();
    keyDown();
    expect(keyDown("z", { repeat: true }).defaultPrevented).toBe(true);
    expect(undo).toHaveBeenCalledOnce();
    expect(editor.getText()).toBe("Saved synthetic draft.");
    editor.view.dom.dispatchEvent(new KeyboardEvent("keyup", { key: "z", bubbles: true }));
    keyDown();
    expect(editor.getText()).toBe("");
  });
});
