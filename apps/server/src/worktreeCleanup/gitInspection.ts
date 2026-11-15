import * as Effect from "effect/Effect";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

export const makeInspectGit = Effect.gen(function* () {
  const git = yield* GitVcsDriver.GitVcsDriver;
  return Effect.fn("WorktreeCleanup.inspectGit")(function* (root: string, args: readonly string[]) {
    const env = Object.fromEntries(
      Object.keys(process.env)
        .filter((name) => name.toUpperCase().startsWith("GIT_"))
        .map((name) => [name, undefined]),
    );
    return yield* git.execute({
      operation: "WorktreeCleanup.inspect",
      cwd: root,
      args: ["-C", root, ...args],
      env,
      timeoutMs: 30_000,
      forceKillAfterMs: 1000,
      maxOutputBytes: 64 * 1024 * 1024,
    });
  });
});
