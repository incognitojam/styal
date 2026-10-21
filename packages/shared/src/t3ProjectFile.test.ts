import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { T3ProjectFile, T3ProjectFileScript } from "@t3tools/contracts";

import {
  parseT3ProjectFile,
  parseT3ProjectFileResult,
  T3ProjectFileFromJson,
} from "./t3ProjectFile.ts";

const decodeJson = Schema.decodeUnknownSync(T3ProjectFileFromJson);

describe("T3ProjectFileFromJson", () => {
  it("decodes lenient JSONC with comments and trailing commas", () => {
    const decoded = decodeJson(`{
      // team scripts
      "iconPath": "assets/logo.svg",
      "scripts": [
        { "name": "Dev", "command": "pnpm dev", },
      ],
    }`);

    expect(decoded.iconPath).toBe("assets/logo.svg");
    expect(decoded.scripts?.[0]).toEqual({ name: "Dev", command: "pnpm dev" });
  });
});

describe("parseT3ProjectFile", () => {
  it("reads project defaults from JSONC with a URL in a block comment", () => {
    expect(
      parseT3ProjectFile(`{
        /* See https://t3.codes/schema/t3.json */
        "defaultThreadEnvMode": "worktree"
      }`),
    ).toEqual({ defaultThreadEnvMode: "worktree" });
  });

  it("returns null for malformed JSON and non-object roots", () => {
    expect(parseT3ProjectFile("{ not json")).toBeNull();
    expect(parseT3ProjectFile("[]")).toBeNull();
  });

  it("ignores one invalid top-level value without discarding valid fields", () => {
    expect(
      parseT3ProjectFile(`{
        "iconPath": "assets/logo.svg",
        "defaultThreadEnvMode": "spaceship",
        "scripts": [{ "name": "Dev", "command": "pnpm dev" }]
      }`),
    ).toEqual({
      iconPath: "assets/logo.svg",
      scripts: [{ name: "Dev", command: "pnpm dev" }],
    });
  });

  it("ignores invalid optional script values without discarding the script", () => {
    expect(
      parseT3ProjectFile(`{
        "scripts": [{
          "name": "Dev",
          "command": "pnpm dev",
          "icon": "spaceship",
          "runOnWorktreeCreate": "yes"
        }]
      }`),
    ).toEqual({ scripts: [{ name: "Dev", command: "pnpm dev" }] });
  });

  it("drops one invalid script without discarding valid siblings", () => {
    expect(
      parseT3ProjectFile(`{
        "scripts": [
          { "name": "Dev", "command": "pnpm dev" },
          { "name": "Broken" },
          { "name": "Test", "command": "pnpm test", "icon": "test" }
        ]
      }`),
    ).toEqual({
      scripts: [
        { name: "Dev", command: "pnpm dev" },
        { name: "Test", command: "pnpm test", icon: "test" },
      ],
    });
  });

  it("applies the script cap after dropping invalid scripts", () => {
    const scripts = [
      ...Array.from({ length: 49 }, (_, index) => ({
        name: `Script ${index + 1}`,
        command: `echo ${index + 1}`,
      })),
      { name: "Broken" },
      { name: "Script 50", command: "echo 50" },
    ];

    expect(parseT3ProjectFile(JSON.stringify({ scripts }))?.scripts).toEqual([
      ...scripts.slice(0, 49),
      scripts[50],
    ]);
  });

  it("reports when it recovered a partially invalid file", () => {
    expect(parseT3ProjectFileResult('{ "defaultThreadEnvMode": "spaceship" }')).toEqual({
      status: "partial",
      file: {},
    });
    expect(parseT3ProjectFileResult('{ "defaultThreadEnvMode": "local" }')).toEqual({
      status: "valid",
      file: { defaultThreadEnvMode: "local" },
    });
    expect(parseT3ProjectFileResult("{ not json")).toEqual({
      status: "invalid",
      file: null,
    });
  });

  it("reports ignored unknown top-level fields as partial", () => {
    expect(
      parseT3ProjectFileResult(`{
        "iconPath": "assets/logo.svg",
        "defaultThreadEnvironmentMode": "worktree"
      }`),
    ).toEqual({
      status: "partial",
      file: { iconPath: "assets/logo.svg" },
    });
  });

  it("reports ignored unknown script fields as partial", () => {
    expect(
      parseT3ProjectFileResult(`{
        "scripts": [{
          "name": "Setup",
          "command": "pnpm install",
          "runOnWorktreeCreation": true
        }]
      }`),
    ).toEqual({
      status: "partial",
      file: { scripts: [{ name: "Setup", command: "pnpm install" }] },
    });
  });
});

describe("parseT3ProjectFileResult field recovery", () => {
  // Sets every schema field to a valid non-default value, so a field the
  // recovery path forgets shows up as missing output.
  const validScript = {
    name: "Setup",
    command: "pnpm install",
    icon: "configure",
    runOnWorktreeCreate: true,
    runOnSettle: true,
    async: false,
  } as const satisfies Required<T3ProjectFileScript>;
  const siblingScript = { name: "Dev", command: "pnpm dev" } as const;
  const validFile = {
    $schema: "https://t3.codes/schema/t3.json",
    iconPath: "assets/logo.svg",
    defaultThreadEnvMode: "local",
    worktreeSubmodules: "none",
    scripts: [validScript, siblingScript],
  } as const satisfies Required<T3ProjectFile>;

  const invalidTopLevelValues = {
    $schema: 42,
    iconPath: "   ",
    defaultThreadEnvMode: "spaceship",
    worktreeSubmodules: "sometimes",
    scripts: "pnpm dev",
  } satisfies Record<keyof T3ProjectFile, unknown>;
  const invalidScriptValues = {
    name: "",
    command: 42,
    icon: "spaceship",
    runOnWorktreeCreate: "yes",
    runOnSettle: "yes",
    async: "no",
  } satisfies Record<keyof T3ProjectFileScript, unknown>;
  const requiredScriptFields: ReadonlySet<string> = new Set(["name", "command"]);

  const omit = <T extends object>(value: T, key: string) =>
    Object.fromEntries(Object.entries(value).filter(([entryKey]) => entryKey !== key));

  it("covers every field of the project file schema", () => {
    expect(Object.keys(validFile).sort()).toEqual(Object.keys(T3ProjectFile.fields).sort());
    expect(Object.keys(invalidTopLevelValues).sort()).toEqual(
      Object.keys(T3ProjectFile.fields).sort(),
    );
    expect(Object.keys(validScript).sort()).toEqual(Object.keys(T3ProjectFileScript.fields).sort());
    expect(Object.keys(invalidScriptValues).sort()).toEqual(
      Object.keys(T3ProjectFileScript.fields).sort(),
    );
  });

  it("reports a file with every field set as valid", () => {
    expect(parseT3ProjectFileResult(JSON.stringify(validFile))).toEqual({
      status: "valid",
      file: validFile,
    });
  });

  it.each(Object.entries(invalidTopLevelValues))(
    "keeps every other field when top-level %s is invalid",
    (key, invalidValue) => {
      expect(
        parseT3ProjectFileResult(JSON.stringify({ ...validFile, [key]: invalidValue })),
      ).toEqual({ status: "partial", file: omit(validFile, key) });
    },
  );

  it.each(Object.entries(invalidScriptValues))(
    "keeps every other field when script %s is invalid",
    (key, invalidValue) => {
      const contents = JSON.stringify({
        ...validFile,
        scripts: [{ ...validScript, [key]: invalidValue }, siblingScript],
      });
      // A required field drops only its script; an optional one drops only itself.
      const recoveredScripts = requiredScriptFields.has(key)
        ? [siblingScript]
        : [omit(validScript, key), siblingScript];

      expect(parseT3ProjectFileResult(contents)).toEqual({
        status: "partial",
        file: { ...validFile, scripts: recoveredScripts },
      });
    },
  );
});
