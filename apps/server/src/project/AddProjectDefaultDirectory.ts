// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/**
 * Where the Add Project browser opens when `addProjectBaseDirectory` is
 * empty. macOS reserves `~/Developer` for code (Finder gives it a hammer
 * icon), so start there when it exists; otherwise start at home.
 */
export const resolveAddProjectDefaultDirectory = (
  options: { readonly platform?: NodeJS.Platform; readonly homeDir?: string } = {},
) =>
  Effect.gen(function* () {
    if ((options.platform ?? process.platform) !== "darwin") {
      return "~/";
    }
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const developerDir = path.join(options.homeDir ?? NodeOS.homedir(), "Developer");
    const info = yield* fileSystem.stat(developerDir).pipe(Effect.option);
    return info._tag === "Some" && info.value.type === "Directory" ? "~/Developer/" : "~/";
  });
