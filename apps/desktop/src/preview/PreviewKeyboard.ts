import type { PreviewAutomationPressInput } from "@t3tools/contracts";
import type { KeyboardInputEvent } from "electron";

interface KeyDefinition {
  readonly code: string;
  readonly key: string;
  readonly keyCode: number;
  readonly accelerator?: string;
  readonly text?: string;
  readonly location?: number;
  readonly shiftedKey?: string;
}

export interface PreviewAutomationKeySequence {
  readonly keyDown: KeyboardInputEvent;
  readonly char?: KeyboardInputEvent;
  readonly keyUp: KeyboardInputEvent;
  readonly editingCommand?: PreviewAutomationEditingCommand;
  readonly signal: {
    readonly kind: "key";
    readonly key: string;
    readonly code: string;
  };
}

export type PreviewAutomationEditingCommand =
  | "copy"
  | "cut"
  | "deleteToBeginningOfLine"
  | "moveToBeginningOfDocument"
  | "moveToBeginningOfDocumentAndModifySelection"
  | "moveToEndOfDocument"
  | "moveToEndOfDocumentAndModifySelection"
  | "moveToLeftEndOfLine"
  | "moveToLeftEndOfLineAndModifySelection"
  | "moveToRightEndOfLine"
  | "moveToRightEndOfLineAndModifySelection"
  | "paste"
  | "redo"
  | "selectAll"
  | "undo";

const NAMED_KEYS: Readonly<Record<string, KeyDefinition>> = {
  Escape: { code: "Escape", key: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", key: "Backspace", keyCode: 8 },
  Tab: { code: "Tab", key: "Tab", keyCode: 9 },
  Enter: { code: "Enter", key: "Enter", keyCode: 13, text: "\r" },
  Shift: { code: "ShiftLeft", key: "Shift", keyCode: 16, location: 1 },
  Control: { code: "ControlLeft", key: "Control", keyCode: 17, location: 1 },
  Alt: { code: "AltLeft", key: "Alt", keyCode: 18, location: 1 },
  Meta: { code: "MetaLeft", key: "Meta", keyCode: 91, location: 1 },
  CapsLock: { code: "CapsLock", key: "CapsLock", keyCode: 20 },
  Space: { code: "Space", key: " ", keyCode: 32, accelerator: "Space", text: " " },
  PageUp: { code: "PageUp", key: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", key: "PageDown", keyCode: 34 },
  End: { code: "End", key: "End", keyCode: 35 },
  Home: { code: "Home", key: "Home", keyCode: 36 },
  ArrowLeft: { code: "ArrowLeft", key: "ArrowLeft", keyCode: 37, accelerator: "Left" },
  ArrowUp: { code: "ArrowUp", key: "ArrowUp", keyCode: 38, accelerator: "Up" },
  ArrowRight: { code: "ArrowRight", key: "ArrowRight", keyCode: 39, accelerator: "Right" },
  ArrowDown: { code: "ArrowDown", key: "ArrowDown", keyCode: 40, accelerator: "Down" },
  Insert: { code: "Insert", key: "Insert", keyCode: 45 },
  Delete: { code: "Delete", key: "Delete", keyCode: 46 },
};

const PRINTABLE_KEYS: ReadonlyArray<KeyDefinition> = [
  { code: "Backquote", key: "`", shiftedKey: "~", keyCode: 192 },
  { code: "Digit1", key: "1", shiftedKey: "!", keyCode: 49 },
  { code: "Digit2", key: "2", shiftedKey: "@", keyCode: 50 },
  { code: "Digit3", key: "3", shiftedKey: "#", keyCode: 51 },
  { code: "Digit4", key: "4", shiftedKey: "$", keyCode: 52 },
  { code: "Digit5", key: "5", shiftedKey: "%", keyCode: 53 },
  { code: "Digit6", key: "6", shiftedKey: "^", keyCode: 54 },
  { code: "Digit7", key: "7", shiftedKey: "&", keyCode: 55 },
  { code: "Digit8", key: "8", shiftedKey: "*", keyCode: 56 },
  { code: "Digit9", key: "9", shiftedKey: "(", keyCode: 57 },
  { code: "Digit0", key: "0", shiftedKey: ")", keyCode: 48 },
  { code: "Minus", key: "-", shiftedKey: "_", keyCode: 189 },
  { code: "Equal", key: "=", shiftedKey: "+", keyCode: 187 },
  { code: "Backslash", key: "\\", shiftedKey: "|", keyCode: 220 },
  { code: "BracketLeft", key: "[", shiftedKey: "{", keyCode: 219 },
  { code: "BracketRight", key: "]", shiftedKey: "}", keyCode: 221 },
  { code: "Semicolon", key: ";", shiftedKey: ":", keyCode: 186 },
  { code: "Quote", key: "'", shiftedKey: '"', keyCode: 222 },
  { code: "Comma", key: ",", shiftedKey: "<", keyCode: 188 },
  { code: "Period", key: ".", shiftedKey: ">", keyCode: 190 },
  { code: "Slash", key: "/", shiftedKey: "?", keyCode: 191 },
];

/** Editing actions macOS normally resolves through native selector handling. */
const MAC_EDITING_COMMANDS: Readonly<Record<string, PreviewAutomationEditingCommand>> = {
  "Meta+Backspace": "deleteToBeginningOfLine",
  "Meta+ArrowUp": "moveToBeginningOfDocument",
  "Meta+ArrowDown": "moveToEndOfDocument",
  "Meta+ArrowLeft": "moveToLeftEndOfLine",
  "Meta+ArrowRight": "moveToRightEndOfLine",
  "Shift+Meta+ArrowUp": "moveToBeginningOfDocumentAndModifySelection",
  "Shift+Meta+ArrowDown": "moveToEndOfDocumentAndModifySelection",
  "Shift+Meta+ArrowLeft": "moveToLeftEndOfLineAndModifySelection",
  "Shift+Meta+ArrowRight": "moveToRightEndOfLineAndModifySelection",
  "Meta+KeyA": "selectAll",
  "Meta+KeyC": "copy",
  "Meta+KeyX": "cut",
  "Meta+KeyV": "paste",
  "Meta+KeyZ": "undo",
  "Shift+Meta+KeyZ": "redo",
};
const SHORTCUT_MODIFIER_ORDER = ["Shift", "Control", "Alt", "Meta"] as const;

const macEditingCommand = (
  code: string,
  modifiers: PreviewAutomationPressInput["modifiers"],
): PreviewAutomationEditingCommand | undefined => {
  const shortcut = [
    ...SHORTCUT_MODIFIER_ORDER.filter((modifier) => modifiers?.includes(modifier)),
    code,
  ].join("+");
  return MAC_EDITING_COMMANDS[shortcut];
};

const electronModifiers = (
  modifiers: PreviewAutomationPressInput["modifiers"],
  implicitShift: boolean,
): NonNullable<KeyboardInputEvent["modifiers"]> => {
  const values = new Set<NonNullable<KeyboardInputEvent["modifiers"]>[number]>();
  for (const modifier of modifiers ?? []) {
    switch (modifier) {
      case "Alt":
        values.add("alt");
        break;
      case "Control":
        values.add("control");
        break;
      case "Meta":
        values.add("meta");
        break;
      case "Shift":
        values.add("shift");
        break;
    }
  }
  if (implicitShift) values.add("shift");
  return [...values];
};

function resolveKeyDefinition(input: PreviewAutomationPressInput): KeyDefinition {
  const named = NAMED_KEYS[input.key];
  if (named) return named;

  const functionKey = /^F([1-9]|1[0-2])$/.exec(input.key);
  if (functionKey) {
    const number = Number(functionKey[1]);
    return { code: input.key, key: input.key, keyCode: 111 + number };
  }

  if (/^[a-z]$/i.test(input.key)) {
    const upper = input.key.toUpperCase();
    const shifted = input.modifiers?.includes("Shift") ?? false;
    const key = shifted || input.key === upper ? upper : input.key;
    return { code: `Key${upper}`, key, keyCode: upper.charCodeAt(0), text: key };
  }

  const printable = PRINTABLE_KEYS.find(
    (definition) => definition.key === input.key || definition.shiftedKey === input.key,
  );
  if (printable) {
    const shifted = input.modifiers?.includes("Shift") ?? false;
    const key =
      printable.shiftedKey && (shifted || input.key === printable.shiftedKey)
        ? printable.shiftedKey
        : printable.key;
    return { ...printable, key, text: key };
  }

  return {
    code: input.key.length > 1 ? input.key : "",
    key: input.key,
    keyCode: 0,
    ...(input.key.length === 1 ? { text: input.key } : {}),
  };
}

/** Build Electron input packets that target the preview guest's render widget. */
export function makePreviewAutomationKeySequence(
  input: PreviewAutomationPressInput,
  options?: { readonly isMac?: boolean },
): PreviewAutomationKeySequence {
  const definition = resolveKeyDefinition(input);
  const implicitShift =
    (/^[A-Z]$/.test(input.key) || definition.shiftedKey === input.key) &&
    !input.modifiers?.includes("Shift");
  const modifiers = electronModifiers(input.modifiers, implicitShift);
  const suppressText = input.modifiers?.some((modifier) => modifier !== "Shift") ?? false;
  const text = suppressText ? "" : (definition.text ?? "");
  const printableDefinition = PRINTABLE_KEYS.find(
    (candidate) => candidate.code === definition.code,
  );
  const keyCode =
    definition.accelerator ??
    (/^Key[A-Z]$/.test(definition.code)
      ? definition.code.slice(3)
      : (printableDefinition?.key ?? definition.key));
  const shared = modifiers.length === 0 ? { keyCode } : { keyCode, modifiers };
  const char =
    text.length === 0
      ? undefined
      : modifiers.length === 0
        ? { type: "char" as const, keyCode: text }
        : { type: "char" as const, keyCode: text, modifiers };
  const editingCommand = options?.isMac
    ? macEditingCommand(definition.code, input.modifiers)
    : undefined;

  return {
    keyDown: { type: "keyDown", ...shared },
    ...(char ? { char } : {}),
    keyUp: { type: "keyUp", ...shared },
    ...(editingCommand ? { editingCommand } : {}),
    signal: { kind: "key", key: definition.key, code: definition.code },
  };
}
