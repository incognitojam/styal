import { describe, expect, it } from "vite-plus/test";

import {
  classifyToolActivity,
  dynamicToolSurface,
  dynamicToolTitle,
  mergeToolActivityData,
} from "./toolActivity.ts";

describe("toolActivity", () => {
  it("classifies from kind and toolName without sniffing titles", () => {
    expect(classifyToolActivity({ data: { kind: "read" } })).toBe("read");
    expect(classifyToolActivity({ data: { toolName: "Grep" } })).toBe("search");
    expect(classifyToolActivity({ data: { toolName: "Read" } })).toBe("read");
    for (const toolName of ["github.read_file", "mongodb.find", "mcp__github__read_file"]) {
      expect(classifyToolActivity({ data: { toolName } })).toBe("other");
    }
    expect(classifyToolActivity({ title: "Find", data: {} })).toBe("other");
  });

  it("classifies Claude search tools ahead of their broad file-read request kind", () => {
    for (const toolName of ["Glob", "Grep", "LS"]) {
      expect(classifyToolActivity({ requestKind: "file-read", data: { toolName } })).toBe("search");
    }
    expect(classifyToolActivity({ requestKind: "file-read", data: { toolName: "Read" } })).toBe(
      "read",
    );
  });

  it("keeps the first non-empty rawInput when a later update is empty", () => {
    expect(
      mergeToolActivityData({ rawInput: { path: "src/a.ts" } }, { rawInput: {}, kind: "read" }),
    ).toEqual({
      rawInput: { path: "src/a.ts" },
      kind: "read",
    });
    expect(
      mergeToolActivityData({ rawInput: { path: "src/a.ts" } }, { rawInput: { startLine: 4 } }),
    ).toEqual({ rawInput: { path: "src/a.ts", startLine: 4 } });
  });

  it.each(["cua_repl.js", "mcp__cua_repl__js", "node_repl.js", "mcp__node_repl__js", "js"])(
    "uses the action title for %s",
    (toolName) => {
      expect(dynamicToolTitle(toolName, { title: " Read the current T3 desktop window " })).toBe(
        "Read the current T3 desktop window",
      );
      const fallback = toolName.includes("cua_repl") ? "Computer use" : "Run JavaScript";
      expect(dynamicToolTitle(toolName, { title: " " })).toBe(fallback);
      expect(dynamicToolTitle(toolName, { title: 123 })).toBe(fallback);
      expect(dynamicToolTitle(toolName, {})).toBe(fallback);
      expect(dynamicToolTitle(toolName, { code: "await sky.get_app_state(app);" })).toBe(
        "Computer use",
      );
    },
  );

  it("recognizes computer-use REPL calls before result metadata exists", () => {
    expect(dynamicToolSurface("cua_repl.js", {})).toBe("computer");
    for (const name of ["node_repl.js", "js"]) {
      expect(dynamicToolSurface(name, { code: "await sky.get_app_state(app);" })).toBe("computer");
      expect(dynamicToolSurface(name, { code: "const sky = await import('@oai/sky');" })).toBe(
        "computer",
      );
      expect(dynamicToolSurface(name, { code: "await fs.readFile(path);" })).toBeUndefined();
    }
    expect(dynamicToolSurface("github.js", { code: "await sky.click(app);" })).toBeUndefined();
  });
});
