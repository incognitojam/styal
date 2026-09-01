import type { ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export interface T3ProjectSetupPluginPaths {
  readonly pluginRoot: string;
  readonly skillsRoot: string;
  readonly skillPath: string;
}

export const T3_PROJECT_SETUP_SKILL_NAME = "t3-project-setup";

export function addT3ProjectSetupSkill(
  snapshot: ServerProvider,
  paths: T3ProjectSetupPluginPaths | undefined,
): ServerProvider {
  if (!paths) return snapshot;
  return {
    ...snapshot,
    skills: [
      ...snapshot.skills.filter((skill) => skill.name !== T3_PROJECT_SETUP_SKILL_NAME),
      {
        name: T3_PROJECT_SETUP_SKILL_NAME,
        description:
          "Configure or improve a repository's T3 Code setup using t3.json, an existing project icon, and useful Actions.",
        path: paths.skillPath,
        scope: "bundled",
        enabled: true,
      },
    ],
  };
}

export const resolveT3ProjectSetupPluginPaths = Effect.fn("resolveT3ProjectSetupPluginPaths")(
  function* (moduleDirectoryOverride?: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const moduleDirectory =
      moduleDirectoryOverride ??
      (yield* path.fromFileUrl(new URL(".", import.meta.url)).pipe(Effect.orDie));
    const candidates = [
      path.resolve(moduleDirectory, "../../../../agent-plugins/t3-project-setup"),
      path.resolve(moduleDirectory, "agent-plugins/t3-project-setup"),
      path.resolve(moduleDirectory, "../../agent-plugins/t3-project-setup"),
    ];

    for (const pluginRoot of candidates) {
      const skillPath = path.join(pluginRoot, "skills/t3-project-setup/SKILL.md");
      const manifestPath = path.join(pluginRoot, ".claude-plugin/plugin.json");
      const completePlugin = yield* Effect.all([
        fileSystem.exists(skillPath).pipe(Effect.orElseSucceed(() => false)),
        fileSystem.exists(manifestPath).pipe(Effect.orElseSucceed(() => false)),
      ]).pipe(Effect.map(([skillExists, manifestExists]) => skillExists && manifestExists));
      if (completePlugin) {
        return {
          pluginRoot,
          skillsRoot: path.join(pluginRoot, "skills"),
          skillPath,
        } satisfies T3ProjectSetupPluginPaths;
      }
    }

    return undefined;
  },
);
