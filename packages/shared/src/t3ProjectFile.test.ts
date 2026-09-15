import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  buildT3ProjectFileJsonSchema,
  parseT3ProjectFile,
  parseT3ProjectFileResult,
  T3ProjectFileFromJson,
} from "./t3ProjectFile.ts";

const decodeJson = Schema.decodeUnknownSync(T3ProjectFileFromJson);

describe("buildT3ProjectFileJsonSchema", () => {
  it("emits a draft 2020-12 schema with the published $id", () => {
    const schema = buildT3ProjectFileJsonSchema();

    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.$id).toBe("https://t3.codes/schema/t3.json");
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
  });

  it("documents every supported field", () => {
    const schema = buildT3ProjectFileJsonSchema() as {
      properties: Record<
        string,
        {
          description?: string;
          items?: { properties: Record<string, unknown>; required: ReadonlyArray<string> };
        }
      >;
      required?: ReadonlyArray<string>;
    };

    expect(Object.keys(schema.properties).sort()).toEqual([
      "$schema",
      "defaultThreadEnvMode",
      "iconPath",
      "scripts",
    ]);
    expect(schema.required).toBeUndefined();
    expect(schema.properties.iconPath?.description).toContain("Workspace-relative path");
    expect(schema.properties.defaultThreadEnvMode?.description).toContain("new threads start");

    const script = schema.properties.scripts?.items;
    expect(script?.required).toEqual(["name", "command"]);
    expect(Object.keys(script?.properties ?? {}).sort()).toEqual([
      "command",
      "icon",
      "name",
      "runOnWorktreeCreate",
    ]);
  });

  it("stays JSON-serializable", () => {
    const schema = buildT3ProjectFileJsonSchema();
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
  });
});

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

  it("fails on malformed JSON", () => {
    expect(() => decodeJson("{ not json")).toThrow();
  });
});

describe("parseT3ProjectFile", () => {
  it("returns the decoded file for valid contents", () => {
    expect(parseT3ProjectFile('{ "defaultThreadEnvMode": "worktree" }')).toEqual({
      defaultThreadEnvMode: "worktree",
    });
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
