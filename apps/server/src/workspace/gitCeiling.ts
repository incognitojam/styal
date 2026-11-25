// @effect-diagnostics processEnvInEffect:off - child processes read the real process environment.
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as PhysicalFileSystem from "@t3tools/shared/PhysicalFileSystem";
import * as Schema from "effect/Schema";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { managedWorktreesDirectories } from "../worktreesDirectory.ts";

export class WorktreeGitDataMissingError extends Schema.TaggedError<WorktreeGitDataMissingError>()(
  "WorktreeGitDataMissingError",
  { worktreePath: Schema.String },
) {
  override get message(): string {
    return `Worktree "${this.worktreePath}" has lost its Git data. Run git worktree repair from the main repository, or move your files out and remove the folder so styal can recreate it.`;
  }
}

export const makeAppendGitCeilings = Effect.gen(function* () {
  const fs = yield* PhysicalFileSystem.PhysicalFileSystem;
  const env = yield* HostProcess.Environment;
  const path = yield* Path.Path;
  const realLocation = (directory: string): Promise<string> =>
    fs.realpath(directory).catch(async () => {
      const parent = path.dirname(directory);
      return parent === directory
        ? directory
        : path.join(await realLocation(parent), path.basename(directory));
    });
  const separator = (yield* HostProcess.Platform) === "win32" ? ";" : ":";
  const warned = new Set<string>();
  return Effect.fn("gitCeiling.append")(function* (directories: ReadonlyArray<string>) {
    for (const directory of directories) {
      const real = yield* Effect.promise(() => realLocation(directory));
      if (real.includes(separator)) {
        if (!warned.has(real)) {
          warned.add(real);
          yield* Effect.logWarning("Git ceiling skipped: separator in path.", { directory: real });
        }
      } else if (!(process.env.GIT_CEILING_DIRECTORIES ?? "").split(separator).includes(real)) {
        const inherited = process.env.GIT_CEILING_DIRECTORIES;
        process.env.GIT_CEILING_DIRECTORIES =
          inherited === undefined ? real : `${inherited}${separator}${real}`;
      }
    }
    if (process.env.GIT_CEILING_DIRECTORIES !== undefined)
      env.GIT_CEILING_DIRECTORIES = process.env.GIT_CEILING_DIRECTORIES;
  });
});

export const start = Effect.fn("gitCeiling.start")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const append = yield* makeAppendGitCeilings;
  yield* append([config.worktreesDir]);
  const changes = yield* settings.subscribeChanges;
  const update = Effect.fn("gitCeiling.update")(
    (value: Parameters<typeof managedWorktreesDirectories>[0]) =>
      append(managedWorktreesDirectories(value, config.worktreesDir, path, home)),
  );
  yield* settings.start.pipe(
    Effect.andThen(settings.getSettings),
    Effect.flatMap(update),
    Effect.ignore({ log: true }),
  );
  return yield* Stream.runForEach(changes, update).pipe(Effect.forkScoped);
});
