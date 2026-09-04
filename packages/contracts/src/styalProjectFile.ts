import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { ThreadEnvMode } from "./environment.ts";
import { MAX_SCRIPT_ID_LENGTH } from "./keybindings.ts";
import { ProjectScriptIcon } from "./orchestration.ts";

/** File name of the checked-in styal project file, resolved at the workspace root. */
export const STYAL_PROJECT_FILE_NAME = "styal.json";

/** Public URL of the published JSON Schema for {@link StyalProjectFile}. */
export const STYAL_PROJECT_FILE_SCHEMA_URL = "https://styal.build/schema/styal.json";

const STYAL_PROJECT_FILE_PATH_MAX_LENGTH = 512;
const STYAL_PROJECT_FILE_MAX_SCRIPTS = 50;

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

const styalProjectFileScriptId = (() => {
  const encoded = Schema.String.annotate({
    description:
      "Stable lowercase identifier used by script keybindings. Defaults to an identifier derived from the name.",
  }).check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(MAX_SCRIPT_ID_LENGTH),
    Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/),
  );
  return encoded.pipe(Schema.decodeTo(encoded, SchemaTransformation.trim()));
})();

export const StyalProjectFileScript = Schema.Struct({
  id: Schema.optionalKey(styalProjectFileScriptId),
  name: trimmedNonEmpty({
    description: "Display name for the script, shown in the T3 Code scripts menu.",
  }),
  command: trimmedNonEmpty({
    description: "Shell command executed in a T3 Code terminal for the active checkout.",
  }),
  icon: Schema.optionalKey(
    ProjectScriptIcon.annotate({
      description: 'Icon shown next to the script in the scripts menu. Defaults to "play".',
    }),
  ),
  setup: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Marks this as the checkout's setup action.",
    }),
  ),
}).annotate({
  description: "A project script T3 Code exposes directly from styal.json.",
});
export type StyalProjectFileScript = typeof StyalProjectFileScript.Type;

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
          'Workspace-relative path to the project icon (e.g. "assets/logo.svg"). Checked before T3 Code\'s built-in icon locations.',
      },
      STYAL_PROJECT_FILE_PATH_MAX_LENGTH,
    ),
  ),
  defaultThreadEnvMode: Schema.optionalKey(
    ThreadEnvMode.annotate({
      description:
        'Where new threads start for this repository: "worktree" for a fresh git worktree, "local" for the current checkout. A per-project setting in T3 Code overrides this; when neither is set, the global default applies.',
    }),
  ),
  scripts: Schema.optionalKey(
    Schema.Array(StyalProjectFileScript)
      .annotate({
        description: "Project scripts shared with everyone who opens this repository in T3 Code.",
      })
      .check(Schema.isMaxLength(STYAL_PROJECT_FILE_MAX_SCRIPTS)),
  ),
}).annotate({
  title: "styal project file",
  description:
    "Checked-in project configuration for styal (styal.json at the repository root). See https://styal.build for documentation.",
});
export type StyalProjectFile = typeof StyalProjectFile.Type;
