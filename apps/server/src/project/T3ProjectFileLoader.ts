/**
 * T3ProjectFileLoader - Effect service that loads the checked-in `t3.json`
 * project file from a workspace root.
 *
 * Loading is best-effort: a missing file resolves to `Option.none`, and
 * unreadable, malformed, or non-object files are logged and treated as
 * absent. Invalid fields and scripts are ignored independently so callers can
 * still use the rest of the file.
 *
 * @module T3ProjectFileLoader
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { T3_PROJECT_FILE_NAME, type T3ProjectFile } from "@t3tools/contracts";
import { parseT3ProjectFileResult } from "@t3tools/shared/t3ProjectFile";

export class T3ProjectFileLoadError extends Schema.TaggedErrorClass<T3ProjectFileLoadError>()(
  "T3ProjectFileLoadError",
  {
    operation: Schema.Literals(["read", "decode"]),
    workspaceRoot: Schema.String,
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} ${T3_PROJECT_FILE_NAME} at ${this.filePath}.`;
  }
}

/** Service tag for t3.json project file loading. */
export class T3ProjectFileLoader extends Context.Service<
  T3ProjectFileLoader,
  {
    /**
     * Load and decode `t3.json` at the workspace root.
     *
     * Never fails: missing, unreadable, malformed, or non-object files resolve
     * to `Option.none` (unreadable files are logged as warnings). Files with
     * individual validation errors return the fields and scripts that remain.
     */
    readonly load: (workspaceRoot: string) => Effect.Effect<Option.Option<T3ProjectFile>>;
  }
>()("t3/project/T3ProjectFileLoader") {}

const logT3ProjectFileLoadError = (error: T3ProjectFileLoadError) =>
  Effect.logWarning(error).pipe(
    Effect.annotateLogs({
      operation: error.operation,
      workspaceRoot: error.workspaceRoot,
      filePath: error.filePath,
      errorTag: error._tag,
    }),
  );

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const load: T3ProjectFileLoader["Service"]["load"] = Effect.fn("T3ProjectFileLoader.load")(
    function* (workspaceRoot) {
      const filePath = path.join(workspaceRoot, T3_PROJECT_FILE_NAME);
      const raw = yield* fileSystem.readFileString(filePath).pipe(
        Effect.map(Option.some),
        Effect.catchTags({
          PlatformError: (error) =>
            error.reason._tag === "NotFound"
              ? Effect.succeed(Option.none<string>())
              : logT3ProjectFileLoadError(
                  new T3ProjectFileLoadError({
                    operation: "read",
                    workspaceRoot,
                    filePath,
                    cause: error,
                  }),
                ).pipe(Effect.as(Option.none<string>())),
        }),
      );
      if (Option.isNone(raw)) {
        return Option.none<T3ProjectFile>();
      }
      const parsed = parseT3ProjectFileResult(raw.value);
      if (parsed.status !== "invalid") {
        return Option.some(parsed.file);
      }
      return yield* logT3ProjectFileLoadError(
        new T3ProjectFileLoadError({
          operation: "decode",
          workspaceRoot,
          filePath,
          cause: new Error("Malformed JSON or non-object project file."),
        }),
      ).pipe(Effect.as(Option.none<T3ProjectFile>()));
    },
  );

  return T3ProjectFileLoader.of({ load });
});

export const layer = Layer.effect(T3ProjectFileLoader, make);
