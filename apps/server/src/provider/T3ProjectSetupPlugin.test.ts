import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { expect } from "vite-plus/test";
import {
  ProjectScriptIcon,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";

import {
  addT3ProjectSetupSkill,
  resolveT3ProjectSetupPluginPaths,
} from "./T3ProjectSetupPlugin.ts";

it.effect("resolves the bundled project setup plugin and skill roots", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const paths = yield* resolveT3ProjectSetupPluginPaths();

    expect(paths).toBeDefined();
    expect(
      yield* fileSystem.exists(path.join(paths!.pluginRoot, ".claude-plugin/plugin.json")),
    ).toBe(true);
    expect(
      yield* fileSystem.exists(path.join(paths!.skillsRoot, "t3-project-setup/SKILL.md")),
    ).toBe(true);
    expect(paths!.skillPath).toBe(path.join(paths!.skillsRoot, "t3-project-setup/SKILL.md"));
    const skill = yield* fileSystem.readFileString(paths!.skillPath);
    for (const icon of ProjectScriptIcon.literals) {
      expect(skill).toContain(`\`${icon}\``);
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("prefers a loose desktop resource outside the asar path", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const resourcesDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-project-setup-desktop-test-",
      });
      const moduleDirectory = path.join(resourcesDirectory, "app.asar/apps/server/dist");
      const pluginRoot = path.join(resourcesDirectory, "agent-plugins/t3-project-setup");
      const skillPath = path.join(pluginRoot, "skills/t3-project-setup/SKILL.md");
      const manifestPath = path.join(pluginRoot, ".claude-plugin/plugin.json");
      yield* fileSystem.makeDirectory(moduleDirectory, { recursive: true });
      yield* fileSystem.makeDirectory(path.dirname(skillPath), { recursive: true });
      yield* fileSystem.makeDirectory(path.dirname(manifestPath), { recursive: true });
      yield* fileSystem.writeFileString(skillPath, "synthetic skill");
      yield* fileSystem.writeFileString(manifestPath, "{}");

      const paths = yield* resolveT3ProjectSetupPluginPaths(moduleDirectory);

      expect(paths?.pluginRoot).toBe(pluginRoot);
      expect(paths?.skillPath).toBe(skillPath);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it("adds the bundled skill to provider snapshots without duplicates", () => {
  const snapshot: ServerProvider = {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-31T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [
      { name: "existing", path: "/synthetic/existing/SKILL.md", enabled: true },
      { name: "t3-project-setup", path: "/stale/SKILL.md", enabled: false },
    ],
  };

  const result = addT3ProjectSetupSkill(snapshot, {
    pluginRoot: "/synthetic/plugin",
    skillsRoot: "/synthetic/plugin/skills",
    skillPath: "/synthetic/plugin/skills/t3-project-setup/SKILL.md",
  });

  expect(addT3ProjectSetupSkill(snapshot, undefined)).toBe(snapshot);
  expect(result.skills).toEqual([
    { name: "existing", path: "/synthetic/existing/SKILL.md", enabled: true },
    {
      name: "t3-project-setup",
      description: expect.any(String),
      path: "/synthetic/plugin/skills/t3-project-setup/SKILL.md",
      scope: "bundled",
      enabled: true,
    },
  ]);
});
