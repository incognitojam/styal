import {
  STYAL_PROJECT_FILE_MAX_ACTIONS,
  StyalProjectFile,
  StyalProjectFileAction,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildStyalProjectFileJsonSchema,
  parseStyalProjectFileResult,
  resolveProjectConfig,
} from "./projectFile.ts";

const VALID_FILE = {
  $schema: "https://styal.build/schema/styal.json",
  iconPath: "assets/logo.svg",
  defaultThreadEnvMode: "worktree",
  worktreeSubmodules: "top-level",
  actions: [
    {
      id: "setup",
      name: "Setup",
      command: "vp i",
      icon: "configure",
      runOnWorktreeCreate: true,
      async: false,
    },
    { id: "clean", name: "Clean", command: "rm -rf dist", runOnSettle: true },
  ],
} as const;

// One invalid value per field; every key the contract defines must be listed
// so a field added later cannot slip past recovery untested.
const INVALID_FILE_FIELDS: Record<keyof typeof StyalProjectFile.fields, unknown> = {
  $schema: 42,
  iconPath: "",
  defaultThreadEnvMode: "elsewhere",
  worktreeSubmodules: "some",
  actions: "not a list",
};
const INVALID_ACTION_FIELDS: Record<keyof typeof StyalProjectFileAction.fields, unknown> = {
  id: "Not Valid",
  name: "   ",
  command: "",
  icon: "rocket",
  runOnWorktreeCreate: "yes",
  runOnSettle: 1,
  async: "no",
};
const REQUIRED_ACTION_FIELDS = new Set(["name", "command"]);

const json = (value: unknown) => JSON.stringify(value);

describe("parseStyalProjectFileResult", () => {
  it("decodes a valid file, comments and trailing commas included", () => {
    expect(parseStyalProjectFileResult(json(VALID_FILE))).toEqual({
      status: "valid",
      file: VALID_FILE,
    });
    expect(
      parseStyalProjectFileResult(`{
        // shared actions
        "actions": [{ "name": "Test", "command": "vp test", },],
      }`),
    ).toEqual({ status: "valid", file: { actions: [{ name: "Test", command: "vp test" }] } });
  });

  it("is invalid for malformed JSON and non-object roots", () => {
    expect(parseStyalProjectFileResult("{").status).toBe("invalid");
    expect(parseStyalProjectFileResult("[]").status).toBe("invalid");
    expect(parseStyalProjectFileResult('"styal"').status).toBe("invalid");
  });

  it("reports unknown keys as partial without dropping known ones", () => {
    const result = parseStyalProjectFileResult(
      json({ ...VALID_FILE, scripts: [], previewUrl: "http://localhost" }),
    );
    expect(result).toEqual({ status: "partial", file: VALID_FILE });
    expect(
      parseStyalProjectFileResult(
        json({ actions: [{ name: "Dev", command: "vp dev", previewUrl: "http://localhost" }] }),
      ),
    ).toEqual({ status: "partial", file: { actions: [{ name: "Dev", command: "vp dev" }] } });
  });

  it.each(Object.entries(INVALID_FILE_FIELDS))(
    "keeps every other field when %s is invalid",
    (key, invalid) => {
      const { [key as keyof typeof VALID_FILE]: _dropped, ...rest } = VALID_FILE;
      expect(parseStyalProjectFileResult(json({ ...VALID_FILE, [key]: invalid }))).toEqual({
        status: "partial",
        file: rest,
      });
    },
  );

  it.each(Object.entries(INVALID_ACTION_FIELDS))(
    "recovers an action whose %s is invalid unless the field is required",
    (key, invalid) => {
      const [setup, clean] = VALID_FILE.actions;
      const { [key as keyof typeof setup]: _dropped, ...setupWithout } = setup;
      const result = parseStyalProjectFileResult(
        json({ ...VALID_FILE, actions: [{ ...setup, [key]: invalid }, clean] }),
      );
      expect(result).toEqual({
        status: "partial",
        file: {
          ...VALID_FILE,
          actions: REQUIRED_ACTION_FIELDS.has(key) ? [clean] : [setupWithout, clean],
        },
      });
    },
  );

  it("keeps the first actions of an over-long list", () => {
    const actions = Array.from({ length: STYAL_PROJECT_FILE_MAX_ACTIONS + 5 }, (_, index) => ({
      name: `Action ${index}`,
      command: "true",
    }));
    const result = parseStyalProjectFileResult(json({ actions }));
    expect(result.status).toBe("partial");
    expect(result.file?.actions).toEqual(actions.slice(0, STYAL_PROJECT_FILE_MAX_ACTIONS));
  });
});

describe("resolveProjectConfig", () => {
  const t3 = json({
    iconPath: "t3.svg",
    defaultThreadEnvMode: "local",
    scripts: [{ name: "Old", command: "make" }],
  });

  it("is missing when neither file exists", () => {
    expect(resolveProjectConfig({ styal: null, t3: null })).toEqual({
      status: "missing",
      config: null,
      legacyScripts: [],
    });
  });

  it("prefers styal.json and ignores t3.json entirely", () => {
    const state = resolveProjectConfig({ styal: json({ iconPath: "styal.svg" }), t3 });
    expect(state).toEqual({
      status: "valid",
      source: "styal.json",
      config: { source: "styal.json", iconPath: "styal.svg", actions: [] },
      legacyScripts: [],
    });
  });

  it("does not fall back to t3.json when styal.json is invalid", () => {
    expect(resolveProjectConfig({ styal: "{", t3 })).toEqual({
      status: "invalid",
      source: "styal.json",
      config: null,
      legacyScripts: [],
    });
  });

  it("reads t3.json settings without its scripts when styal.json is absent", () => {
    expect(resolveProjectConfig({ styal: null, t3 })).toEqual({
      status: "valid",
      source: "t3.json",
      config: { source: "t3.json", iconPath: "t3.svg", defaultThreadEnvMode: "local", actions: [] },
      legacyScripts: [{ name: "Old", command: "make" }],
    });
  });

  it("fills in action ids and icons, keeping the first of duplicate ids", () => {
    const state = resolveProjectConfig({
      styal: json({
        actions: [
          { name: "Run Tests", command: "vp test" },
          { id: "run-tests", name: "Explicit", command: "vp test --all", icon: "test" },
          { id: "run-tests", name: "Duplicate", command: "false" },
          { name: "Run Tests", command: "vp test --watch" },
        ],
      }),
      t3: null,
    });
    expect(state.config?.actions).toEqual([
      { id: "run-tests-2", name: "Run Tests", command: "vp test", icon: "play" },
      { id: "run-tests", name: "Explicit", command: "vp test --all", icon: "test" },
      { id: "run-tests-3", name: "Run Tests", command: "vp test --watch", icon: "play" },
    ]);
  });
});

describe("buildStyalProjectFileJsonSchema", () => {
  it("publishes a closed schema under the styal.build id", () => {
    const schema = buildStyalProjectFileJsonSchema();
    expect(schema.$id).toBe("https://styal.build/schema/styal.json");
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties as object)).toEqual(Object.keys(StyalProjectFile.fields));
  });
});
