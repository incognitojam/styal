import { type ClientSettings, THREAD_JUMP_KEYBINDING_COMMANDS } from "@t3tools/contracts";
import { compileResolvedKeybindingsConfig } from "@t3tools/shared/keybindings";
import { describe, expect, it } from "vite-plus/test";

import { buildShortcutsOverview } from "./ShortcutsOverview.logic";

const overview = (
  rules: Parameters<typeof compileResolvedKeybindingsConfig>[0],
  isDesktop = false,
  sendShortcut: ClientSettings["sendShortcut"] = "enter",
) =>
  buildShortcutsOverview(compileResolvedKeybindingsConfig(rules), {
    platform: "Linux x86_64",
    isDesktop,
    sendShortcut,
  });

const commandsIn = (groups: ReturnType<typeof overview>) =>
  groups.flatMap((group) => group.entries.map((entry) => entry.command));

describe("buildShortcutsOverview", () => {
  it("groups commands like Settings and merges a command's shortcuts", () => {
    expect(
      overview([
        { key: "mod+j", command: "terminal.toggle" },
        { key: "mod+n", command: "chat.new" },
        { key: "mod+shift+o", command: "chat.new" },
      ]),
    ).toEqual([
      {
        id: "threads",
        title: "Threads",
        entries: [
          { command: "chat.new", label: "Chat: New", shortcuts: ["Ctrl+N", "Ctrl+Shift+O"] },
        ],
      },
      {
        id: "terminal",
        title: "Terminal",
        entries: [{ command: "terminal.toggle", label: "Terminal: Toggle", shortcuts: ["Ctrl+J"] }],
      },
    ]);
  });

  it("keeps bindings that only apply while something is focused", () => {
    expect(
      commandsIn(overview([{ key: "mod+d", command: "terminal.split", when: "terminalFocus" }])),
    ).toEqual(["terminal.split"]);
  });

  it("leaves out bindings only the other client can use", () => {
    const rules = [
      { key: "mod+1", command: "sidebar.toggle", when: "!modelPickerOpen && isDesktop" },
      { key: "mod+2", command: "chat.new", when: "!isDesktop" },
      { key: "mod+3", command: "terminal.toggle", when: "isDesktop || terminalFocus" },
    ] as const;
    expect(commandsIn(overview([...rules], false))).toEqual(["chat.new", "terminal.toggle"]);
    expect(commandsIn(overview([...rules], true))).toEqual(["sidebar.toggle", "terminal.toggle"]);
  });

  it("leaves out a rule a later rule overrides for the same keys", () => {
    expect(
      commandsIn(
        overview([
          { key: "mod+k", command: "commandPalette.toggle", when: "!terminalFocus" },
          { key: "mod+k", command: "chat.new" },
          { key: "mod+j", command: "terminal.toggle" },
          { key: "mod+j", command: "preview.toggle", when: "previewFocus" },
        ]),
      ),
    ).toEqual(["chat.new", "terminal.toggle", "preview.toggle"]);
  });

  it("shows the alternate send key the send setting makes effective", () => {
    const rules = [
      { key: "mod+enter", command: "composer.sendAlternate", when: "composerFocus && turnRunning" },
    ] as const;
    const shortcuts = (setting: ClientSettings["sendShortcut"]) =>
      overview([...rules], false, setting)[0]?.entries[0]?.shortcuts;
    expect(shortcuts("enter")).toEqual(["Ctrl+Enter"]);
    expect(shortcuts("mod-enter")).toEqual(["Ctrl+Shift+Enter"]);
    expect(shortcuts("mod-enter-multiline")).toEqual(["Ctrl+Enter", "Ctrl+Shift+Enter"]);
  });

  it("collapses jump commands to one row while their keys follow the digits", () => {
    const jumps = (keyFor: (digit: number) => string) =>
      THREAD_JUMP_KEYBINDING_COMMANDS.map((command, index) => ({
        key: keyFor(index + 1),
        command,
      }));
    expect(overview(jumps((digit) => `mod+${digit}`))[0]?.entries).toEqual([
      { command: "thread.jump.1", label: "Thread: Jump: 1–9", shortcuts: ["Ctrl+1–9"] },
    ]);
    const rebound = overview(jumps((digit) => (digit === 4 ? "mod+shift+x" : `mod+${digit}`)));
    expect(rebound[0]?.entries).toHaveLength(9);
  });

  it("lists a shifted glyph once, without naming Shift", () => {
    expect(
      overview([
        { key: "mod+shift+/", command: "shortcutsOverview.toggle" },
        { key: "mod+shift+?", command: "shortcutsOverview.toggle" },
        { key: "mod+shift+/", command: "chat.new", when: "previewFocus" },
      ]).flatMap((group) => group.entries.map((entry) => [entry.command, entry.shortcuts])),
    ).toEqual([
      ["shortcutsOverview.toggle", ["Ctrl+?"]],
      ["chat.new", ["Ctrl+Shift+/"]],
    ]);
  });
});
