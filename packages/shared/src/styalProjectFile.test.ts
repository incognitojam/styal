import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  buildStyalProjectFileJsonSchema,
  parseStyalProjectFile,
  StyalProjectFileFromJson,
} from "./styalProjectFile.ts";

const decodeJson = Schema.decodeUnknownSync(StyalProjectFileFromJson);

describe("buildStyalProjectFileJsonSchema", () => {
  it("emits a draft 2020-12 schema with the published $id", () => {
    const schema = buildStyalProjectFileJsonSchema();

    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.$id).toBe("https://styal.build/schema/styal.json");
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
  });

  it("documents every supported field", () => {
    const schema = buildStyalProjectFileJsonSchema() as {
      properties: Record<
        string,
        {
          description?: string;
          items?: {
            properties: Record<
              string,
              { pattern?: string; allOf?: ReadonlyArray<{ pattern?: string }> }
            >;
            required: ReadonlyArray<string>;
          };
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
    expect(Object.keys(script?.properties ?? {}).sort()).toEqual(["command", "icon", "id", "name"]);
    expect(script?.properties.id?.allOf).toContainEqual({
      pattern: "^[a-z0-9][a-z0-9-]*$",
    });
  });

  it("stays JSON-serializable", () => {
    const schema = buildStyalProjectFileJsonSchema();
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
  });
});

describe("StyalProjectFileFromJson", () => {
  it("decodes lenient JSONC with comments and trailing commas", () => {
    const decoded = decodeJson(`{
      // team scripts
      "iconPath": "assets/logo.svg",
      "scripts": [
        { "id": "dev", "name": "Dev", "command": "pnpm dev", },
      ],
    }`);

    expect(decoded.iconPath).toBe("assets/logo.svg");
    expect(decoded.scripts?.[0]).toEqual({ id: "dev", name: "Dev", command: "pnpm dev" });
  });

  it("fails on malformed JSON", () => {
    expect(() => decodeJson("{ not json")).toThrow();
  });
});

describe("parseStyalProjectFile", () => {
  it("returns the decoded file for valid contents", () => {
    expect(parseStyalProjectFile('{ "defaultThreadEnvMode": "worktree" }')).toEqual({
      defaultThreadEnvMode: "worktree",
    });
  });

  it("returns null for malformed or invalid contents", () => {
    expect(parseStyalProjectFile("{ not json")).toBeNull();
    expect(parseStyalProjectFile('{ "defaultThreadEnvMode": "spaceship" }')).toBeNull();
  });
});
