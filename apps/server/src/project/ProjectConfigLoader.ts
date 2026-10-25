/**
 * Reads `styal.json`, or a legacy `t3.json` when there is none. Loading never fails: unreadable
 * files count as missing, and invalid fields and actions are ignored independently so callers
 * can still use the rest.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { STYAL_PROJECT_FILE_NAME, T3_PROJECT_FILE_NAME } from "@t3tools/contracts";
import { resolveProjectConfig, type ProjectConfigState } from "@t3tools/shared/projectFile";

export class ProjectConfigLoadError extends Schema.TaggedError<ProjectConfigLoadError>()(
  "ProjectConfigLoadError",
  {
    operation: Schema.Literals(["read", "decode"]),
    workspaceRoot: Schema.String,
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} project configuration at ${this.filePath}.`;
  }
}

/** Service tag for project configuration loading. */
export class ProjectConfigLoader extends Context.Service<
  ProjectConfigLoader,
  {
    /** Load and resolve the project configuration at the workspace root. */
    readonly load: (workspaceRoot: string) => Effect.Effect<ProjectConfigState>;
  }
>()("@styal/cli/project/ProjectConfigLoader") {}

const logProjectConfigLoadError = (error: ProjectConfigLoadError) =>
  Effect.logWarning(error).pipe(
    Effect.annotateLogs({
      operation: error.operation,
      workspaceRoot: error.workspaceRoot,
      filePath: error.filePath,
      errorTag: error._tag,
    }),
  );

/** @public */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const readOptional = (workspaceRoot: string, fileName: string) => {
    const filePath = path.join(workspaceRoot, fileName);
    return fileSystem.readFileString(filePath).pipe(
      Effect.map((contents): string | null => contents),
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed(null)
            : logProjectConfigLoadError(
                new ProjectConfigLoadError({
                  operation: "read",
                  workspaceRoot,
                  filePath,
                  cause: error,
                }),
              ).pipe(Effect.as(null)),
      }),
    );
  };

  const load: ProjectConfigLoader["Service"]["load"] = Effect.fn("ProjectConfigLoader.load")(
    function* (workspaceRoot) {
      const styal = yield* readOptional(workspaceRoot, STYAL_PROJECT_FILE_NAME);
      // t3.json only matters when there is no styal.json.
      const t3 = styal === null ? yield* readOptional(workspaceRoot, T3_PROJECT_FILE_NAME) : null;
      const state = resolveProjectConfig({ styal, t3 });
      if (state.status === "invalid") {
        yield* logProjectConfigLoadError(
          new ProjectConfigLoadError({
            operation: "decode",
            workspaceRoot,
            filePath: path.join(workspaceRoot, state.source),
            cause: new Error("Malformed JSON or non-object project file."),
          }),
        );
      }
      return state;
    },
  );

  return ProjectConfigLoader.of({ load });
});

export const layer = Layer.effect(ProjectConfigLoader, make);
