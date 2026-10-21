import { DEFAULT_SERVER_SETTINGS, ProjectId, type ProjectScript } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isSetupScriptOutsideWorktree,
  resolveProjectActions,
  projectScriptRuntimeEnv,
  withT3CodeProjectEnvironmentAliases,
} from "./projectScripts.ts";

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

describe("resolveProjectActions", () => {
  const projectId = ProjectId.make("project-1");
  const local = (id: string, command = `run ${id}`): ProjectScript => ({
    id,
    name: id,
    command,
    icon: "play",
    runOnWorktreeCreate: false,
  });
  const settingsWith = (scripts: ProjectScript[]) => ({
    ...DEFAULT_SERVER_SETTINGS,
    projectSettingsFolded: true,
    projectSettingsOverrides: { [projectId]: { defaultProjectScripts: scripts } },
  });
  const project = { id: projectId, scripts: [], workspaceRoot: "/repo" };

  it("lists saved actions first, then file actions they do not override", () => {
    const actions = resolveProjectActions(
      settingsWith([local("lint", "vp lint --fix"), local("dev")]),
      project,
      {
        actions: [
          { id: "test", name: "Test", command: "vp test", icon: "test" },
          { id: "lint", name: "Lint", command: "vp lint", icon: "lint" },
        ],
      },
    );
    expect(actions.map(({ id, source, command }) => ({ id, source, command }))).toEqual([
      { id: "lint", source: "override", command: "vp lint --fix" },
      { id: "dev", source: "local", command: "run dev" },
      { id: "test", source: "file", command: "vp test" },
    ]);
  });

  it("never lets an unapproved file action run on its own", () => {
    const [setup] = resolveProjectActions(settingsWith([]), project, {
      actions: [
        {
          id: "setup",
          name: "Setup",
          command: "vp i",
          icon: "configure",
          runOnWorktreeCreate: true,
          runOnSettle: true,
          async: false,
        },
      ],
    });
    expect(setup).toEqual({
      id: "setup",
      name: "Setup",
      command: "vp i",
      icon: "configure",
      runOnWorktreeCreate: false,
      source: "file",
      awaitingApproval: ["setup", "settle"],
    });
  });

  const setupFile = {
    actions: [
      {
        id: "setup",
        name: "Setup",
        command: "vp i",
        icon: "configure" as const,
        runOnWorktreeCreate: true,
        runOnSettle: true,
        async: false,
      },
    ],
  };
  const approving = (command: string, roles: ("setup" | "settle")[]) => ({
    ...settingsWith([]),
    projectFileActionApprovals: {
      [`project:${projectId}`]: {
        setup: { command, roles, approvedAt: "2026-10-21T12:00:00.000Z" },
      },
    },
  });

  it("runs an approved file action in the roles it was approved for", () => {
    const [setup] = resolveProjectActions(approving("vp i", ["setup"]), project, setupFile);
    expect(setup).toMatchObject({
      runOnWorktreeCreate: true,
      async: false,
      awaitingApproval: ["settle"],
    });
    expect(setup?.runOnSettle).toBeUndefined();
  });

  it("voids an approval once the file's command changes", () => {
    const [setup] = resolveProjectActions(
      approving("vp install", ["setup", "settle"]),
      project,
      setupFile,
    );
    expect(setup).toMatchObject({
      runOnWorktreeCreate: false,
      awaitingApproval: ["setup", "settle"],
    });
  });

  it("is the saved list alone without a project file", () => {
    expect(resolveProjectActions(settingsWith([local("dev")]), project, null)).toEqual([
      { ...local("dev"), source: "local" },
    ]);
  });
});
