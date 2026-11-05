import { compileResolvedKeybindingsConfig } from "@t3tools/shared/keybindings";
import { describe, expect, it } from "vite-plus/test";

import { buildShortcutsOverview } from "./ShortcutsOverview.logic";

const overview = (
  rules: Parameters<typeof compileResolvedKeybindingsConfig>[0],
  isDesktop = false,
) =>
  buildShortcutsOverview(compileResolvedKeybindingsConfig(rules), {
    platform: "Linux x86_64",
    isDesktop,
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
      { key: "mod+1", command: "thread.jump.1", when: "!modelPickerOpen && isDesktop" },
      { key: "mod+2", command: "thread.jump.2", when: "!isDesktop" },
      { key: "mod+3", command: "thread.jump.3", when: "isDesktop || terminalFocus" },
    ] as const;
    expect(commandsIn(overview([...rules], false))).toEqual(["thread.jump.2", "thread.jump.3"]);
    expect(commandsIn(overview([...rules], true))).toEqual(["thread.jump.1", "thread.jump.3"]);
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
});
