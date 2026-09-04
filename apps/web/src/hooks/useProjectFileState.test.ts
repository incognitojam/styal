import type { ProjectScript, StyalProjectFile, T3ProjectFile } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { resolveProjectFileState } from "./useProjectFileState";
import type { StyalProjectFileState } from "./useStyalProjectFileScripts";
import type { T3ProjectFileState } from "./useT3ProjectFileScripts";

const refresh = vi.fn();
const liveScript: ProjectScript = {
  id: "dev",
  name: "Dev",
  command: "vp run dev",
  icon: "play",
  runOnWorktreeCreate: false,
};
const styalFile: StyalProjectFile = {
  defaultThreadEnvMode: "worktree",
  scripts: [{ id: "dev", name: "Dev", command: "vp run dev" }],
};
const t3File: T3ProjectFile = {
  defaultThreadEnvMode: "local",
  scripts: [{ name: "Legacy", command: "vp run legacy" }],
};

function state(styal: StyalProjectFileState, t3: T3ProjectFileState) {
  return resolveProjectFileState({ styal, t3, refresh });
}

describe("resolveProjectFileState", () => {
  it("uses live styal.json actions instead of legacy imports", () => {
    const resolved = state(
      { status: "valid", file: styalFile, scripts: [liveScript], refresh },
      { status: "valid", file: t3File, scripts: t3File.scripts ?? [], refresh },
    );

    expect(resolved.source).toBe("styal.json");
    expect(resolved.liveScripts).toEqual([liveScript]);
    expect(resolved.legacyScripts).toEqual([]);
    expect(resolved.defaultThreadEnvMode).toBe("worktree");
  });

  it("falls back to import-only t3.json when styal.json is missing", () => {
    const resolved = state(
      { status: "missing", file: null, scripts: [], refresh },
      { status: "valid", file: t3File, scripts: t3File.scripts ?? [], refresh },
    );

    expect(resolved.source).toBe("t3.json");
    expect(resolved.liveScripts).toEqual([]);
    expect(resolved.legacyScripts).toEqual(t3File.scripts);
    expect(resolved.defaultThreadEnvMode).toBe("local");
  });

  it("does not hide invalid styal.json behind t3.json", () => {
    const resolved = state(
      { status: "invalid", file: null, scripts: [], refresh },
      { status: "valid", file: t3File, scripts: t3File.scripts ?? [], refresh },
    );

    expect(resolved).toMatchObject({
      status: "invalid",
      source: "styal.json",
      liveScripts: [],
      legacyScripts: [],
    });
  });
});
