import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const STYAL_SKILL_NAME = "styal-guides";
export const STYAL_GUIDE_TOOL = "read_styal_guide";

export interface StyalSkillPaths {
  /** Claude plugin root, holding `.claude-plugin` and `skills`. */
  readonly pluginRoot: string;
  /** Holds one folder per skill, for providers that take a skill root. */
  readonly skillsRoot: string;
  readonly skillDirectory: string;
  readonly skillFile: string;
}

export const styalSkillPaths = (
  path: Pick<Path.Path, "join">,
  stateDir: string,
): StyalSkillPaths => {
  const pluginRoot = path.join(stateDir, "agent-skills", "styal");
  const skillsRoot = path.join(pluginRoot, "skills");
  const skillDirectory = path.join(skillsRoot, STYAL_SKILL_NAME);
  return {
    pluginRoot,
    skillsRoot,
    skillDirectory,
    skillFile: path.join(skillDirectory, "SKILL.md"),
  };
};

/** The server writes the skill at startup. A session without it keeps the guide tool and its line. */
export const resolveStyalSkill = Effect.fn("resolveStyalSkill")(function* (stateDir: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = styalSkillPaths(yield* Path.Path, stateDir);
  const available = yield* fileSystem
    .exists(paths.skillFile)
    .pipe(Effect.orElseSucceed(() => false));
  return available ? paths : undefined;
});
