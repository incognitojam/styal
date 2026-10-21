import { shortcutLabelForCommand } from "./keybindings";
import { describe, expect, it } from "vite-plus/test";
import {
  projectScriptRuntimeEnv,
  settleProjectScript,
  setupProjectScript,
} from "@t3tools/shared/projectScripts";

import {
  commandForProjectScript,
  nextProjectScriptId,
  primaryProjectScript,
  releaseClaimedRoles,
  withSavedProjectScript,
  buildProjectScript,
} from "./projectScripts";

describe("projectScripts helpers", () => {
  it.each(["install-javascript-dependencies", "A", "a.b", "a b", "-a", "", "a".repeat(25)])(
    "omits the shortcut for legacy script ID %j without crashing script menus",
    (id) => {
      const commands = ["lint", id, "test"].map(commandForProjectScript);
      expect(commands).toEqual(["script.lint.run", null, "script.test.run"]);
      expect(commands.map((command) => shortcutLabelForCommand([], command))).toEqual([
        null,
        null,
        null,
      ]);
    },
  );

  it("slugifies and dedupes project script ids", () => {
    expect(nextProjectScriptId("Run Tests", [])).toBe("run-tests");
    expect(nextProjectScriptId("Run Tests", ["run-tests"])).toBe("run-tests-2");
    expect(nextProjectScriptId("!!!", [])).toBe("script");
  });

  it("resolves primary, setup, and settle scripts", () => {
    const scripts = [
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure" as const,
        runOnWorktreeCreate: true,
      },
      {
        id: "clean",
        name: "Clean",
        command: "cargo clean",
        icon: "build" as const,
        runOnWorktreeCreate: false,
        runOnSettle: true,
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
    expect(settleProjectScript(scripts)?.id).toBe("clean");
    expect(primaryProjectScript(scripts.filter((script) => script.id === "clean"))).toBeNull();
  });

  it("moves the setup and settle roles to the script that claims them", () => {
    const input = {
      name: "Next",
      command: "true",
      icon: "play",
      waitForSetup: false,
    } as const;
    const holder = {
      id: "holder",
      name: "Holder",
      command: "true",
      icon: "play" as const,
      runOnWorktreeCreate: true,
      runOnSettle: true,
    };

    expect(
      releaseClaimedRoles(holder, { ...input, runOnWorktreeCreate: false, runOnSettle: true }),
    ).toMatchObject({ runOnWorktreeCreate: true, runOnSettle: false });
    expect(
      releaseClaimedRoles(holder, { ...input, runOnWorktreeCreate: true, runOnSettle: false }),
    ).toMatchObject({ runOnWorktreeCreate: false, runOnSettle: true });
    expect(
      releaseClaimedRoles(holder, { ...input, runOnWorktreeCreate: false, runOnSettle: false }),
    ).toBe(holder);
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
  });
});

describe("withSavedProjectScript", () => {
  const input = {
    name: "Lint",
    command: "vp lint --fix",
    icon: "lint" as const,
    runOnWorktreeCreate: false,
    waitForSetup: false,
    runOnSettle: false,
  };
  const saved = (id: string, extra: Partial<ReturnType<typeof buildProjectScript>> = {}) => ({
    ...buildProjectScript(id, { ...input, name: id, command: `run ${id}` }),
    ...extra,
  });

  it("replaces a saved action in place", () => {
    expect(
      withSavedProjectScript([saved("dev"), saved("lint"), saved("test")], "lint", input).map(
        (script) => script.command,
      ),
    ).toEqual(["run dev", "vp lint --fix", "run test"]);
  });

  it("appends an action that is not saved yet, such as an override of a styal.json action", () => {
    const next = withSavedProjectScript([saved("dev")], "lint", input);
    expect(next.map((script) => script.id)).toEqual(["dev", "lint"]);
    expect(next[1]).toEqual(buildProjectScript("lint", input));
  });

  it("takes the setup role from the saved action that held it", () => {
    const next = withSavedProjectScript(
      [saved("setup", { runOnWorktreeCreate: true })],
      "install",
      { ...input, runOnWorktreeCreate: true },
    );
    expect(next.map(({ id, runOnWorktreeCreate }) => ({ id, runOnWorktreeCreate }))).toEqual([
      { id: "setup", runOnWorktreeCreate: false },
      { id: "install", runOnWorktreeCreate: true },
    ]);
  });
});
