import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { ThreadEnvMode, WorktreeSubmodules } from "./environment.ts";
import { MAX_SCRIPT_ID_LENGTH } from "./keybindings.ts";
import { ProjectScriptIcon } from "./project.ts";
import type { ProjectScriptIcon as ProjectScriptIconType } from "./project.ts";
import type { ProjectScopedServerSettingKey, ServerSettings } from "./settings.ts";

/** File name of the checked-in styal project file, resolved at the project root. */
export const STYAL_PROJECT_FILE_NAME = "styal.json";

/** Public URL of the published JSON Schema for {@link StyalProjectFile}. */
export const STYAL_PROJECT_FILE_SCHEMA_URL = "https://styal.build/schema/styal.json";

const STYAL_PROJECT_FILE_PATH_MAX_LENGTH = 512;
export const STYAL_PROJECT_FILE_MAX_ACTIONS = 50;

// Annotations go on the encoded (string) side so they survive into the
// published JSON Schema; decoding still trims and re-validates non-emptiness.
const trimmedNonEmpty = (annotations: { readonly description: string }, maxLength?: number) => {
  const annotated = Schema.String.annotate(annotations);
  const encoded =
    maxLength === undefined
      ? annotated.check(Schema.isNonEmpty())
      : annotated.check(Schema.isNonEmpty(), Schema.isMaxLength(maxLength));
  return encoded.pipe(Schema.decodeTo(encoded, SchemaTransformation.trim()));
};

// Same shape as the id in a `script.<id>.run` keybinding, so a file action
// can be bound without renaming it.
const actionId = Schema.String.annotate({
  description:
    "Stable identifier for the action, used by keybindings and to override it locally. Lowercase letters, digits and dashes. Defaults to one derived from the name.",
}).check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_SCRIPT_ID_LENGTH),
  Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/),
);

export const StyalProjectFileAction = Schema.Struct({
  id: Schema.optionalKey(actionId),
  name: trimmedNonEmpty({
    description: "Display name for the action, shown in the styal actions menu.",
  }),
  command: trimmedNonEmpty({
    description: "Shell command executed in a styal terminal in the thread's checkout.",
  }),
  icon: Schema.optionalKey(
    ProjectScriptIcon.annotate({
      description: 'Icon shown next to the action in the actions menu. Defaults to "play".',
    }),
  ),
  runOnWorktreeCreate: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "When true, the action runs automatically after a worktree is created for a new thread, once you approve its command in styal.",
    }),
  ),
  runOnSettle: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "When true, the action runs in the thread's worktree each time the thread settles, for example to delete build output, once you approve its command in styal. Threads without their own worktree skip it.",
    }),
  ),
  async: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Only for runOnWorktreeCreate actions. When true (the default), the agent starts while the action is still running. Set false to hold the agent until the action exits.",
    }),
  ),
}).annotate({
  description: "A project action shared with everyone who opens this repository in styal.",
});
export type StyalProjectFileAction = typeof StyalProjectFileAction.Type;

export const StyalProjectFile = Schema.Struct({
  $schema: Schema.optionalKey(
    Schema.String.annotate({
      description: `URL of the JSON Schema for this file, typically "${STYAL_PROJECT_FILE_SCHEMA_URL}".`,
    }),
  ),
  iconPath: Schema.optionalKey(
    trimmedNonEmpty(
      {
        description:
          'Project-relative path to the project icon (e.g. "assets/logo.svg"). Checked before styal\'s built-in icon locations.',
      },
      STYAL_PROJECT_FILE_PATH_MAX_LENGTH,
    ),
  ),
  defaultThreadEnvMode: Schema.optionalKey(
    ThreadEnvMode.annotate({
      description:
        'Where new threads start for this repository: "worktree" for a fresh git worktree, "local" for the current checkout. A project or environment setting in styal overrides this.',
    }),
  ),
  worktreeSubmodules: Schema.optionalKey(
    WorktreeSubmodules.annotate({
      description:
        'How new worktrees populate git submodules: "recursive" (the default) initializes nested submodules too, "top-level" initializes only those declared by this repository, and "none" leaves every submodule empty for a setup action to handle. A project or environment setting in styal overrides this.',
    }),
  ),
  actions: Schema.optionalKey(
    Schema.Array(StyalProjectFileAction)
      .annotate({
        description: "Project actions shared with everyone who opens this repository in styal.",
      })
      .check(Schema.isMaxLength(STYAL_PROJECT_FILE_MAX_ACTIONS)),
  ),
}).annotate({
  title: "styal project file",
  description:
    "Checked-in project configuration for styal (styal.json at the repository root). See https://styal.build for documentation.",
});
export type StyalProjectFile = typeof StyalProjectFile.Type;

/** The checked-in files styal reads project configuration from, newest first. */
export type ProjectConfigFileName = typeof STYAL_PROJECT_FILE_NAME | "t3.json";

/**
 * The project configuration styal applies, whichever file it came from.
 * `styal.json` wins; a legacy `t3.json` is only read when there is no
 * `styal.json`, and then contributes its settings and icon but never its
 * scripts, which are offered for migration instead.
 */
export interface ProjectConfig extends Omit<StyalProjectFile, "$schema" | "actions"> {
  readonly source: ProjectConfigFileName;
  readonly actions: ReadonlyArray<ProjectConfigAction>;
}

/** A file action with its id derived from the name when the file leaves it out. */
export type ProjectConfigAction = StyalProjectFileAction & {
  readonly id: string;
  readonly icon: ProjectScriptIconType;
};

/**
 * A key here must be nullable on `ServerSettings` (null means inherit) so the project override
 * and environment value can defer to the file. Listing a key here is the whole change for a new
 * file-backed setting.
 */
export const PROJECT_FILE_BACKED_SETTINGS = {
  // Clients use the current checkout when the project is not a Git repo or
  // has no commit to branch from, without changing this inherited default.
  defaultThreadEnvMode: { field: "defaultThreadEnvMode", builtIn: "worktree" },
  worktreeSubmodules: { field: "worktreeSubmodules", builtIn: "recursive" },
} as const satisfies {
  // providerInstances overrides individual fields, so it cannot use whole-setting file inheritance.
  readonly [K in ProjectScopedServerSettingKey & keyof ServerSettings]?: {
    readonly field: {
      readonly [F in keyof ProjectConfig]: ProjectConfig[F] extends
        | Exclude<ServerSettings[K], null>
        | undefined
        ? F
        : never;
    }[keyof ProjectConfig];
    readonly builtIn: Exclude<ServerSettings[K], null>;
  };
};
export type ProjectFileBackedSettingKey = keyof typeof PROJECT_FILE_BACKED_SETTINGS;

/**
 * `ServerSettings` with every file-backed key resolved to a concrete value.
 * What `resolveProjectSettings(...).settings` produces once the project file
 * (or its absence) has been accounted for.
 */
export type ResolvedServerSettings = Omit<ServerSettings, ProjectFileBackedSettingKey> & {
  readonly [K in ProjectFileBackedSettingKey]: Exclude<ServerSettings[K], null>;
};
