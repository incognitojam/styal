import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { parseT3ProjectFile, T3ProjectFileFromJson } from "./t3ProjectFile.ts";
import { projectScriptTerminalInput } from "./projectScripts.ts";

const decodeJson = Schema.decodeUnknownSync(T3ProjectFileFromJson);

describe("T3ProjectFileFromJson", () => {
  it.each(
    [
      ...Array.from({ length: 32 }, (_, code) => code).filter(
        (code) => ![9, 10, 13].includes(code),
      ),
      ...Array.from({ length: 33 }, (_, index) => 127 + index),
      0x061c,
      0x200e,
      0x200f,
      ...Array.from({ length: 5 }, (_, index) => 0x202a + index),
      ...Array.from({ length: 4 }, (_, index) => 0x2066 + index),
      13,
    ].map((code) => [code.toString(16).toUpperCase().padStart(4, "0"), String.fromCharCode(code)]),
  )("rejects hidden command character U+%s and names the action", (code, character) => {
    expect(() =>
      decodeJson(
        JSON.stringify({
          scripts: [{ name: "Preview", command: `echo before${character}echo after` }],
        }),
      ),
    ).toThrow(`Action "Preview" command contains disallowed character U+${code}`);
  });

  it.each(["echo one\necho two", "echo one\r\necho two", "echo\tone", "echo café"])(
    "preserves visible multiline/tab command text without adding hidden body characters: %j",
    (command) => {
      const decoded = decodeJson(JSON.stringify({ scripts: [{ name: "Preview", command }] }));
      expect(decoded.scripts?.[0]?.command).toBe(command);
      expect(projectScriptTerminalInput(command)).toBe(` ${command}\r`);
    },
  );

  it("decodes lenient JSONC with comments and trailing commas", () => {
    const decoded = decodeJson(`{
      // team scripts
      "iconPath": "assets/logo.svg",
      "scripts": [
        { "name": "Dev", "command": "pnpm dev", "stopOnSettle": true, },
      ],
    }`);

    expect(decoded.iconPath).toBe("assets/logo.svg");
    expect(decoded.scripts?.[0]).toEqual({ name: "Dev", command: "pnpm dev", stopOnSettle: true });
  });
});

describe("parseT3ProjectFile", () => {
  it("reads project defaults from JSONC with a URL in a block comment", () => {
    expect(
      parseT3ProjectFile(`{
        /* See https://restart.styal.invalid/schema/t3.json */
        "defaultThreadEnvMode": "worktree"
      }`),
    ).toEqual({ defaultThreadEnvMode: "worktree" });
  });
});
