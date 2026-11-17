import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  WorktreeCleanupError,
  type ProjectId,
  type WorktreeCleanupReview,
} from "@t3tools/contracts";
import { resolveProjectConfig } from "@t3tools/shared/projectFile";
import * as ProjectService from "../project/ProjectService.ts";
import { makeInspectGit } from "./gitInspection.ts";

export const makeReadPatterns = Effect.gen(function* () {
  const inspectGit = yield* makeInspectGit;
  return Effect.fn("WorktreeCleanup.readPatterns")(function* (root: string) {
    const head = yield* inspectGit(root, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
    const defaultBranch =
      head.exitCode === 0 ? head.stdout.trim().replace(/^refs\/remotes\/origin\//, "") : null;
    // Without remote HEAD, use Git's conventional local default branches, never the current branch.
    const candidates = defaultBranch === null ? ["main", "master"] : [defaultBranch];
    for (const branch of candidates) {
      const ref = `refs/heads/${branch}`;
      const exists = yield* inspectGit(root, ["show-ref", "--verify", "--quiet", ref]);
      if (exists.exitCode !== 0) continue;
      const file = yield* inspectGit(root, ["show", `${ref}:styal.json`]);
      if (file.exitCode !== 0 || file.stdoutTruncated) return [];
      return resolveProjectConfig({ styal: file.stdout, t3: null }).config?.worktreeCleanup ?? [];
    }
    return [];
  });
});

export class Patterns extends Context.Service<
  Patterns,
  {
    readonly review: (input: {
      readonly projectId: ProjectId;
    }) => Effect.Effect<typeof WorktreeCleanupReview.Type, WorktreeCleanupError>;
  }
>()("@styal/cli/worktreeCleanup/Patterns") {}

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const read = yield* makeReadPatterns;
  const review = Effect.fn("WorktreeCleanup.review")(function* (input: {
    readonly projectId: ProjectId;
  }) {
    const project = yield* projects.getById(input.projectId).pipe(
      Effect.mapError(
        () =>
          new WorktreeCleanupError({
            reason: "project-not-found",
            message: "Project not found.",
          }),
      ),
    );
    if (Option.isNone(project))
      return yield* new WorktreeCleanupError({
        reason: "project-not-found",
        message: "Project not found.",
      });
    const patterns = yield* read(project.value.workspaceRoot).pipe(
      Effect.mapError(
        () =>
          new WorktreeCleanupError({
            reason: "run-failed",
            message: "Could not read cleanup patterns from the default branch.",
          }),
      ),
    );
    return { patterns };
  });
  return Patterns.of({ review });
});
export const layer = Layer.effect(Patterns, make);
