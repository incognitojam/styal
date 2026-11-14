import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  WorktreeCleanupError,
  type WorktreeCleanupReview,
  type ProjectId,
} from "@t3tools/contracts";
import { projectFileApprovalKey } from "@t3tools/shared/projectFileApprovals";
import * as ProjectConfigLoader from "../project/ProjectConfigLoader.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";

// Action ids cannot contain $, so this slot cannot collide with a declared action.
const APPROVAL_SLOT = "$worktreeCleanup";
export class Approvals extends Context.Service<
  Approvals,
  {
    readonly review: (input: {
      readonly projectId: ProjectId;
    }) => Effect.Effect<WorktreeCleanupReview, WorktreeCleanupError>;
    readonly setApproved: (input: {
      readonly projectId: ProjectId;
      readonly approved: boolean;
    }) => Effect.Effect<WorktreeCleanupReview, WorktreeCleanupError>;
  }
>()("@styal/cli/worktreeCleanup/Approvals") {}

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const loader = yield* ProjectConfigLoader.ProjectConfigLoader;
  const settings = yield* ServerSettings.ServerSettingsService;
  const resolve = Effect.fn("WorktreeCleanup.resolveApproval")(function* (projectId: ProjectId) {
    const project = yield* projects.getById(projectId).pipe(
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
    const state = yield* loader.load(project.value.workspaceRoot);
    if (
      state.status === "invalid" ||
      (state.status === "partial" &&
        state.issues.some((issue) => issue.path[0] === "worktreeCleanup"))
    ) {
      return yield* new WorktreeCleanupError({
        reason: "nothing-to-approve",
        message: "Fix the invalid worktreeCleanup field before previewing or approving it.",
      });
    }
    return { key: projectFileApprovalKey(project.value), patterns: state.config?.worktreeCleanup };
  });
  const reviewOf = Effect.fn("WorktreeCleanup.reviewApproval")(function* (
    resolved: Effect.Success<ReturnType<typeof resolve>>,
  ) {
    const saved = yield* settings.getSettings.pipe(
      Effect.mapError(
        () =>
          new WorktreeCleanupError({ reason: "save-failed", message: "Could not read settings." }),
      ),
    );
    const previous = saved.projectFileActionApprovals[resolved.key]?.[APPROVAL_SLOT]?.patterns;
    return {
      patterns: resolved.patterns ?? [],
      previouslyApprovedPatterns: previous ?? null,
      status:
        resolved.patterns === undefined
          ? "none"
          : previous === undefined
            ? "unapproved"
            : previous.length === resolved.patterns.length &&
                previous.every((pattern, index) => pattern === resolved.patterns![index])
              ? "approved"
              : "changed",
    } satisfies WorktreeCleanupReview;
  });
  const review = Effect.fn("WorktreeCleanup.review")(function* (input: {
    readonly projectId: ProjectId;
  }) {
    return yield* reviewOf(yield* resolve(input.projectId));
  });
  const setApproved = Effect.fn("WorktreeCleanup.setApproved")(function* (input: {
    readonly projectId: ProjectId;
    readonly approved: boolean;
  }) {
    const resolved = yield* resolve(input.projectId);
    if (input.approved && resolved.patterns === undefined)
      return yield* new WorktreeCleanupError({
        reason: "nothing-to-approve",
        message: "No worktreeCleanup list is declared.",
      });
    const approvedAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
    yield* settings.getSettings.pipe(
      Effect.flatMap((saved) => {
        const { [APPROVAL_SLOT]: _previous, ...others } =
          saved.projectFileActionApprovals[resolved.key] ?? {};
        return settings.updateSettings({
          projectFileActionApprovals: {
            ...saved.projectFileActionApprovals,
            [resolved.key]: input.approved
              ? {
                  ...others,
                  [APPROVAL_SLOT]: {
                    command: "worktreeCleanup",
                    roles: [],
                    patterns: resolved.patterns!,
                    approvedAt,
                  },
                }
              : others,
          },
        });
      }),
      Effect.mapError(
        () =>
          new WorktreeCleanupError({ reason: "save-failed", message: "Could not save settings." }),
      ),
    );
    return yield* reviewOf(resolved);
  });
  return Approvals.of({ review, setApproved });
});
export const layer = Layer.effect(Approvals, make);
