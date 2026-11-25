import * as HostProcess from "@t3tools/shared/HostProcess";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { fixture, nodeLayer } from "./fixtures.testkit.ts";
import { makeInspectGit } from "./gitInspection.ts";

it.live.each(["project subfolder", "damaged managed worktree"] as const)(
  "preserves the inspection ceiling: %s",
  (layout) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const damaged = layout === "damaged managed worktree";
      if (damaged) {
        yield* f.command(f.base, ["init"]);
        yield* f.fs.remove(`${f.worktree}/.git`);
      }
      const environment = yield* HostProcess.Environment;
      const inherited = environment.GIT_CEILING_DIRECTORIES;
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          environment.GIT_CEILING_DIRECTORIES = damaged ? f.config.worktreesDir : f.base;
        }),
        () =>
          Effect.sync(() => {
            if (inherited === undefined) delete environment.GIT_CEILING_DIRECTORIES;
            else environment.GIT_CEILING_DIRECTORIES = inherited;
          }),
      );
      const cwd = damaged ? f.worktree : `${f.root}/src`;
      if (!damaged) yield* f.fs.makeDirectory(cwd);
      const inspect = yield* makeInspectGit.pipe(
        Effect.provideService(GitVcsDriver.GitVcsDriver, f.git),
      );
      const result = yield* inspect(cwd, ["rev-parse", "--git-common-dir"]);
      if (damaged) expect(result.exitCode).not.toBe(0);
      else {
        expect(result.exitCode).toBe(0);
        expect(yield* f.fs.realPath(`${cwd}/${result.stdout.trim()}`)).toBe(
          yield* f.fs.realPath(`${f.root}/.git`),
        );
      }
    }).pipe(Effect.provide(nodeLayer)),
);
