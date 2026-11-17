import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  WorktreeCleanupError,
  type ProjectId,
  type WorktreeCleanupReview,
} from "@t3tools/contracts";
import * as ProjectService from "../project/ProjectService.ts";
import { makeReadPatterns } from "./PatternSource.ts";

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
