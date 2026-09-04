/**
 * StyalProjectFileLoader - Effect service that loads the checked-in `styal.json`
 * project file from a workspace root.
 *
 * Loading is best-effort: a missing file resolves to `Option.none`, and
 * unreadable or invalid files are logged and treated as absent so callers
 * can fall back to their defaults.
 *
 * @module StyalProjectFileLoader
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { STYAL_PROJECT_FILE_NAME, type StyalProjectFile } from "@t3tools/contracts";
import { StyalProjectFileFromJson } from "@t3tools/shared/styalProjectFile";

const decodeStyalProjectFileJson = Schema.decodeEffect(StyalProjectFileFromJson);

export class StyalProjectFileLoadError extends Schema.TaggedErrorClass<StyalProjectFileLoadError>()(
  "StyalProjectFileLoadError",
  {
    operation: Schema.Literals(["read", "decode"]),
    workspaceRoot: Schema.String,
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} ${STYAL_PROJECT_FILE_NAME} at ${this.filePath}.`;
  }
}

/** Service tag for styal.json project file loading. */
export class StyalProjectFileLoader extends Context.Service<
  StyalProjectFileLoader,
  {
    /**
     * Load and decode `styal.json` at the workspace root.
     *
     * Never fails: missing, unreadable, or invalid files resolve to
     * `Option.none` (invalid files are logged as warnings).
     */
    readonly load: (workspaceRoot: string) => Effect.Effect<Option.Option<StyalProjectFile>>;
    /** Whether the checkout contains styal.json, including an invalid or unreadable file. */
    readonly exists: (workspaceRoot: string) => Effect.Effect<boolean>;
  }
>()("t3/project/StyalProjectFileLoader") {}

const logStyalProjectFileLoadError = (error: StyalProjectFileLoadError) =>
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

  const load: StyalProjectFileLoader["Service"]["load"] = Effect.fn("StyalProjectFileLoader.load")(
    function* (workspaceRoot) {
      const filePath = path.join(workspaceRoot, STYAL_PROJECT_FILE_NAME);
      const raw = yield* fileSystem.readFileString(filePath).pipe(
        Effect.map(Option.some),
        Effect.catchTags({
          PlatformError: (error) =>
            error.reason._tag === "NotFound"
              ? Effect.succeed(Option.none<string>())
              : logStyalProjectFileLoadError(
                  new StyalProjectFileLoadError({
                    operation: "read",
                    workspaceRoot,
                    filePath,
                    cause: error,
                  }),
                ).pipe(Effect.as(Option.none<string>())),
        }),
      );
      if (Option.isNone(raw)) {
        return Option.none<StyalProjectFile>();
      }
      return yield* decodeStyalProjectFileJson(raw.value).pipe(
        Effect.map(Option.some),
        Effect.catchTags({
          SchemaError: (error) =>
            logStyalProjectFileLoadError(
              new StyalProjectFileLoadError({
                operation: "decode",
                workspaceRoot,
                filePath,
                cause: error,
              }),
            ).pipe(Effect.as(Option.none<StyalProjectFile>())),
        }),
      );
    },
  );

  const exists: StyalProjectFileLoader["Service"]["exists"] = Effect.fn(
    "StyalProjectFileLoader.exists",
  )((workspaceRoot) =>
    fileSystem
      .exists(path.join(workspaceRoot, STYAL_PROJECT_FILE_NAME))
      // A filesystem error must not reopen the legacy auto-run path.
      .pipe(Effect.orElseSucceed(() => true)),
  );

  return StyalProjectFileLoader.of({ load, exists });
});

export const layer = Layer.effect(StyalProjectFileLoader, make);
