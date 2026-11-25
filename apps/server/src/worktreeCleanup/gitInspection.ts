import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

export const makeInspectGit = Effect.gen(function* () {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const environment = yield* HostProcess.Environment;
  return Effect.fn("WorktreeCleanup.inspectGit")(function* (
    root: string,
    args: readonly string[],
    stdin?: string,
  ) {
    const env = Object.fromEntries(
      Object.keys(environment)
        .filter((name) => name.toUpperCase().startsWith("GIT_"))
        .map((name) => [name, undefined]),
    );
    return yield* git.execute({
      operation: "WorktreeCleanup.inspect",
      cwd: root,
      args: ["-C", root, ...args],
      env: { ...env, GIT_CEILING_DIRECTORIES: environment.GIT_CEILING_DIRECTORIES },
      timeoutMs: 30_000,
      maxOutputBytes: 64 * 1024 * 1024,
      allowNonZeroExit: true,
      ...(stdin === undefined ? {} : { stdin }),
    });
  });
});
