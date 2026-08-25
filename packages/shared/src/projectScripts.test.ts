import { describe, expect, it } from "vite-plus/test";

import { isSetupScriptOutsideWorktree } from "./projectScripts.ts";

const setupScript = { runOnWorktreeCreate: true } as const;
const regularScript = { runOnWorktreeCreate: false } as const;

describe("isSetupScriptOutsideWorktree", () => {
  it("allows a setup script in a worktree of its project", () => {
    expect(
      isSetupScriptOutsideWorktree({
        script: setupScript,
        projectCwd: "/repo/project",
        worktreePath: "/repo/worktrees/a",
      }),
    ).toBe(false);
  });

  it("refuses a setup script with no worktree", () => {
    expect(
      isSetupScriptOutsideWorktree({
        script: setupScript,
        projectCwd: "/repo/project",
        worktreePath: null,
      }),
    ).toBe(true);
    expect(isSetupScriptOutsideWorktree({ script: setupScript, projectCwd: "/repo/project" })).toBe(
      true,
    );
  });

  it("refuses a setup script pointed at the project root, trailing separators aside", () => {
    expect(
      isSetupScriptOutsideWorktree({
        script: setupScript,
        projectCwd: "/repo/project",
        worktreePath: "/repo/project",
      }),
    ).toBe(true);
    expect(
      isSetupScriptOutsideWorktree({
        script: setupScript,
        projectCwd: "/repo/project/",
        worktreePath: "/repo/project",
      }),
    ).toBe(true);
  });

  it("leaves ordinary scripts alone wherever they run", () => {
    expect(
      isSetupScriptOutsideWorktree({
        script: regularScript,
        projectCwd: "/repo/project",
        worktreePath: null,
      }),
    ).toBe(false);
    expect(
      isSetupScriptOutsideWorktree({
        script: regularScript,
        projectCwd: "/repo/project",
        worktreePath: "/repo/project",
      }),
    ).toBe(false);
  });
});
