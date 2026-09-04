import { describe, expect, it } from "vite-plus/test";
import {
  mergeProjectScripts,
  projectScriptCwd,
  projectScriptRuntimeEnv,
  projectScriptsFromStyalFile,
  setupProjectScript,
} from "@t3tools/shared/projectScripts";

import {
  buildProjectScript,
  commandForProjectScript,
  nextProjectScriptId,
  primaryProjectScript,
  projectScriptIdFromCommand,
} from "./projectScripts";

describe("projectScripts helpers", () => {
  it("builds scripts", () => {
    expect(
      buildProjectScript("dev", {
        name: "Dev server",
        command: "pnpm dev",
        icon: "debug",
        runOnWorktreeCreate: false,
      }),
    ).toEqual({
      id: "dev",
      name: "Dev server",
      command: "pnpm dev",
      icon: "debug",
      runOnWorktreeCreate: false,
    });
  });

  it("builds and parses script run commands", () => {
    const command = commandForProjectScript("lint");
    expect(command).toBe("script.lint.run");
    expect(projectScriptIdFromCommand(command)).toBe("lint");
    expect(projectScriptIdFromCommand("terminal.toggle")).toBeNull();
  });

  it("slugifies and dedupes project script ids", () => {
    expect(nextProjectScriptId("Run Tests", [])).toBe("run-tests");
    expect(nextProjectScriptId("Run Tests", ["run-tests"])).toBe("run-tests-2");
    expect(nextProjectScriptId("!!!", [])).toBe("script");
  });

  it("resolves primary and setup scripts", () => {
    const scripts = [
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure" as const,
        runOnWorktreeCreate: true,
      },
      {
        id: "test",
        name: "Test",
        command: "bun test",
        icon: "test" as const,
        runOnWorktreeCreate: false,
      },
    ];

    expect(primaryProjectScript(scripts)?.id).toBe("test");
    expect(setupProjectScript(scripts)?.id).toBe("setup");
  });

  it("builds default runtime env for scripts", () => {
    const env = projectScriptRuntimeEnv({
      project: { cwd: "/repo" },
      worktreePath: "/repo/worktree-a",
    });

    expect(env).toMatchObject({
      STYAL_PROJECT_ROOT: "/repo",
      STYAL_WORKTREE_PATH: "/repo/worktree-a",
      T3CODE_PROJECT_ROOT: "/repo",
      T3CODE_WORKTREE_PATH: "/repo/worktree-a",
    });
  });

  it("shadows saved scripts by ID without breaking shortcuts for other saved IDs", () => {
    const fileScripts = projectScriptsFromStyalFile([
      { id: "dev", name: "Dev", command: "vp run dev", icon: "play" },
      { name: "Run Tests", command: "vp test" },
    ]);
    const merged = mergeProjectScripts(fileScripts, [
      buildProjectScript("dev", {
        name: "Dev",
        command: "old dev command",
        icon: "play",
        runOnWorktreeCreate: false,
      }),
      buildProjectScript("legacy-dev", {
        name: "Dev",
        command: "vp run dev",
        icon: "play",
        runOnWorktreeCreate: false,
      }),
      buildProjectScript("lint", {
        name: "Lint",
        command: "vp lint",
        icon: "lint",
        runOnWorktreeCreate: false,
      }),
    ]);

    expect(merged.map((script) => script.id)).toEqual(["dev", "run-tests", "legacy-dev", "lint"]);
    expect(merged[0]?.command).toBe("vp run dev");
  });

  it("allows overriding runtime env values", () => {
    const env = projectScriptRuntimeEnv({
      project: { cwd: "/repo" },
      extraEnv: {
        STYAL_PROJECT_ROOT: "/custom-root",
        CUSTOM_FLAG: "1",
      },
    });

    expect(env.STYAL_PROJECT_ROOT).toBe("/custom-root");
    expect(env.T3CODE_PROJECT_ROOT).toBe("/custom-root");
    expect(env.CUSTOM_FLAG).toBe("1");
    expect(env.STYAL_WORKTREE_PATH).toBeUndefined();
    expect(env.T3CODE_WORKTREE_PATH).toBeUndefined();
  });

  it("prefers the worktree path for script cwd resolution", () => {
    expect(
      projectScriptCwd({
        project: { cwd: "/repo" },
        worktreePath: "/repo/worktree-a",
      }),
    ).toBe("/repo/worktree-a");
    expect(
      projectScriptCwd({
        project: { cwd: "/repo" },
        worktreePath: null,
      }),
    ).toBe("/repo");
  });
});
