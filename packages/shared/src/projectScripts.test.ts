import { describe, expect, it } from "vite-plus/test";

import {
  isSetupScriptOutsideWorktree,
  projectScriptsFromStyalFile,
  projectScriptRuntimeEnv,
  withT3CodeProjectEnvironmentAliases,
} from "./projectScripts.ts";

const setupScript = { runOnWorktreeCreate: true } as const;
const regularScript = { runOnWorktreeCreate: false } as const;

describe("projectScriptsFromStyalFile", () => {
  it("keeps checked-in actions manual", () => {
    expect(projectScriptsFromStyalFile([{ id: "setup", name: "Setup", command: "vp i" }])).toEqual([
      {
        id: "setup",
        name: "Setup",
        command: "vp i",
        icon: "play",
        runOnWorktreeCreate: false,
      },
    ]);
  });
});

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

describe("project process environment compatibility", () => {
  it("exposes legacy aliases from canonical project context", () => {
    expect(
      projectScriptRuntimeEnv({
        project: { cwd: "/repo" },
        worktreePath: "/repo/worktree-a",
        extraEnv: { STYAL_WORKSPACE_PORT: "24120" },
      }),
    ).toMatchObject({
      STYAL_PROJECT_ROOT: "/repo",
      STYAL_WORKTREE_PATH: "/repo/worktree-a",
      STYAL_WORKSPACE_PORT: "24120",
      T3CODE_PROJECT_ROOT: "/repo",
      T3CODE_WORKTREE_PATH: "/repo/worktree-a",
      T3CODE_WORKSPACE_PORT: "24120",
    });
  });

  it("does not treat legacy names as styal inputs", () => {
    expect(
      withT3CodeProjectEnvironmentAliases({
        T3CODE_PROJECT_ROOT: "/legacy/repo",
        T3CODE_WORKTREE_PATH: "/legacy/worktree",
        T3CODE_WORKSPACE_PORT: "24000",
      }),
    ).toEqual({
      T3CODE_PROJECT_ROOT: "/legacy/repo",
      T3CODE_WORKTREE_PATH: "/legacy/worktree",
      T3CODE_WORKSPACE_PORT: "24000",
    });
  });

  it("overwrites conflicting legacy names with canonical values", () => {
    expect(
      withT3CodeProjectEnvironmentAliases({
        STYAL_PROJECT_ROOT: "/repo",
        T3CODE_PROJECT_ROOT: "/legacy/repo",
      }),
    ).toEqual({
      STYAL_PROJECT_ROOT: "/repo",
      T3CODE_PROJECT_ROOT: "/repo",
    });
  });
});
