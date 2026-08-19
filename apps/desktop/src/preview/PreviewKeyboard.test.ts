import { describe, expect, it } from "vite-plus/test";

import { makePreviewAutomationKeySequence } from "./PreviewKeyboard.ts";

describe("preview keyboard packets", () => {
  it("sends Enter directly to the guest with a char event", () => {
    expect(makePreviewAutomationKeySequence({ key: "Enter" })).toEqual({
      keyDown: { type: "keyDown", keyCode: "Enter" },
      char: { type: "char", keyCode: "\r" },
      keyUp: { type: "keyUp", keyCode: "Enter" },
      signal: { kind: "key", key: "Enter", code: "Enter" },
    });
  });

  it("dispatches printable keys with a char event", () => {
    const sequence = makePreviewAutomationKeySequence({ key: "z" });
    expect(sequence.keyDown).toEqual({ type: "keyDown", keyCode: "Z" });
    expect(sequence.char).toEqual({ type: "char", keyCode: "z" });
    expect(sequence.keyUp).toEqual({ type: "keyUp", keyCode: "Z" });
    expect(sequence.signal).toEqual({ kind: "key", key: "z", code: "KeyZ" });
  });

  it("suppresses char events for shortcuts", () => {
    const sequence = makePreviewAutomationKeySequence({ key: "a", modifiers: ["Meta"] });
    expect(sequence.keyDown).toEqual({ type: "keyDown", keyCode: "A", modifiers: ["meta"] });
    expect(sequence.char).toBeUndefined();
    expect(sequence.keyUp).toEqual({ type: "keyUp", keyCode: "A", modifiers: ["meta"] });
    expect(sequence.editingCommand).toBeUndefined();
  });

  it.each([
    ["a", ["Meta"], "selectAll"],
    ["c", ["Meta"], "copy"],
    ["x", ["Meta"], "cut"],
    ["v", ["Meta"], "paste"],
    ["z", ["Meta"], "undo"],
    ["z", ["Shift", "Meta"], "redo"],
    ["Backspace", ["Meta"], "deleteToBeginningOfLine"],
    ["ArrowUp", ["Meta"], "moveToBeginningOfDocument"],
    ["ArrowDown", ["Meta"], "moveToEndOfDocument"],
    ["ArrowLeft", ["Meta"], "moveToLeftEndOfLine"],
    ["ArrowRight", ["Meta"], "moveToRightEndOfLine"],
    ["ArrowUp", ["Shift", "Meta"], "moveToBeginningOfDocumentAndModifySelection"],
    ["ArrowDown", ["Shift", "Meta"], "moveToEndOfDocumentAndModifySelection"],
    ["ArrowLeft", ["Shift", "Meta"], "moveToLeftEndOfLineAndModifySelection"],
    ["ArrowRight", ["Shift", "Meta"], "moveToRightEndOfLineAndModifySelection"],
  ] as const)("maps macOS %s with %s to %s", (key, modifiers, editingCommand) => {
    expect(
      makePreviewAutomationKeySequence({ key, modifiers: [...modifiers] }, { isMac: true })
        .editingCommand,
    ).toBe(editingCommand);
  });

  it("includes implicit Shift when resolving uppercase macOS shortcuts", () => {
    const sequence = makePreviewAutomationKeySequence(
      { key: "Z", modifiers: ["Meta"] },
      { isMac: true },
    );

    expect(sequence.keyDown).toEqual({
      type: "keyDown",
      keyCode: "Z",
      modifiers: ["meta", "shift"],
    });
    expect(sequence.editingCommand).toBe("redo");
  });

  it("resolves shifted printable keys to their browser values", () => {
    const sequence = makePreviewAutomationKeySequence({ key: "1", modifiers: ["Shift"] });
    expect(sequence.keyDown).toEqual({ type: "keyDown", keyCode: "1", modifiers: ["shift"] });
    expect(sequence.char).toEqual({ type: "char", keyCode: "!", modifiers: ["shift"] });
    expect(sequence.signal).toEqual({ kind: "key", key: "!", code: "Digit1" });
  });

  it("adds the physical Shift modifier for shifted characters", () => {
    const sequence = makePreviewAutomationKeySequence({ key: "!" });
    expect(sequence.keyDown).toEqual({ type: "keyDown", keyCode: "1", modifiers: ["shift"] });
    expect(sequence.char).toEqual({ type: "char", keyCode: "!", modifiers: ["shift"] });
    expect(sequence.signal).toEqual({ kind: "key", key: "!", code: "Digit1" });
  });

  it("keeps shifted key values while suppressing char events for modified chords", () => {
    const sequence = makePreviewAutomationKeySequence({
      key: "1",
      modifiers: ["Control", "Shift"],
    });
    expect(sequence.keyDown).toEqual({
      type: "keyDown",
      keyCode: "1",
      modifiers: ["control", "shift"],
    });
    expect(sequence.char).toBeUndefined();
    expect(sequence.signal).toEqual({ kind: "key", key: "!", code: "Digit1" });
  });

  it("uses Electron accelerator names for arrow keys", () => {
    expect(makePreviewAutomationKeySequence({ key: "ArrowLeft" }).keyDown).toEqual({
      type: "keyDown",
      keyCode: "Left",
    });
  });
});
