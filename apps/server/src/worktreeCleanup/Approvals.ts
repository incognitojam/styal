import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  WorktreeCleanupError,
  type WorktreeCleanupReview,
  type WorktreeCleanupApproveResult,
  type WorktreeCleanupApproveInput,
  type WorktreeCleanupRevokeInput,
  type ProjectId,
} from "@t3tools/contracts";
import * as ProjectConfigLoader from "../project/ProjectConfigLoader.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";

export class Approvals extends Context.Service<
  Approvals,
  {
    readonly review: (input: {
      readonly projectId: ProjectId;
    }) => Effect.Effect<WorktreeCleanupReview, WorktreeCleanupError>;
    readonly approve: (
      input: WorktreeCleanupApproveInput,
    ) => Effect.Effect<WorktreeCleanupApproveResult, WorktreeCleanupError>;
    readonly revoke: (
      input: WorktreeCleanupRevokeInput,
    ) => Effect.Effect<WorktreeCleanupReview, WorktreeCleanupError>;
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
        message: "Fix the invalid worktreeCleanup field before approving it.",
      });
    }
    const patterns = state.config?.worktreeCleanup;
    return {
      key: project.value.id,
      hasField: patterns !== undefined,
      patterns: [...new Set(patterns?.map((pattern) => pattern.trim()) ?? [])],
    };
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
    const approved = saved.worktreeCleanupApprovals[resolved.key] ?? {};
    const declared = resolved.patterns.map((pattern) => ({
      pattern,
      status: Object.hasOwn(approved, pattern) ? ("approved" as const) : ("pending" as const),
    }));
    return {
      status: !resolved.hasField
        ? "none"
        : declared.some((entry) => entry.status === "pending")
          ? "pending"
          : "approved",
      declared,
      approvedNotDeclared: Object.entries(approved)
        .filter(([pattern]) => !resolved.patterns.includes(pattern))
        .map(([pattern, approval]) => ({ pattern, approvedAt: approval.approvedAt })),
    } satisfies WorktreeCleanupReview;
  });
  const review = Effect.fn("WorktreeCleanup.review")(function* (input: {
    readonly projectId: ProjectId;
  }) {
    return yield* reviewOf(yield* resolve(input.projectId));
  });
  const approve = Effect.fn("WorktreeCleanup.approve")(function* (
    input: WorktreeCleanupApproveInput,
  ) {
    const resolved = yield* resolve(input.projectId);
    const shown = new Set(input.patterns.map((pattern) => pattern.trim()));
    const approvedAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
    yield* settings
      .modifySettings((saved) => {
        const previous = saved.worktreeCleanupApprovals[resolved.key] ?? {};
        const additions = Object.fromEntries(
          resolved.patterns
            .filter((pattern) => shown.has(pattern) && !Object.hasOwn(previous, pattern))
            .map((pattern) => [pattern, { approvedAt }]),
        );
        if (Object.keys(additions).length === 0) return {};
        return {
          worktreeCleanupApprovals: {
            ...saved.worktreeCleanupApprovals,
            [resolved.key]: { ...previous, ...additions },
          },
        };
      })
      .pipe(
        Effect.mapError(
          () =>
            new WorktreeCleanupError({
              reason: "save-failed",
              message: "Could not save settings.",
            }),
        ),
      );
    return {
      ...(yield* reviewOf(resolved)),
      notDeclared: [...shown].filter((pattern) => !resolved.patterns.includes(pattern)),
    };
  });
  const revoke = Effect.fn("WorktreeCleanup.revoke")(function* (input: WorktreeCleanupRevokeInput) {
    const resolved = yield* resolve(input.projectId);
    yield* settings
      .modifySettings((saved) => {
        const previous = saved.worktreeCleanupApprovals[resolved.key] ?? {};
        const remaining = Object.fromEntries(
          Object.entries(previous).filter(
            ([pattern]) => input.pattern !== null && pattern !== input.pattern.trim(),
          ),
        );
        const { [resolved.key]: _previous, ...others } = saved.worktreeCleanupApprovals;
        return {
          worktreeCleanupApprovals:
            Object.keys(remaining).length === 0 ? others : { ...others, [resolved.key]: remaining },
        };
      })
      .pipe(
        Effect.mapError(
          () =>
            new WorktreeCleanupError({
              reason: "save-failed",
              message: "Could not save settings.",
            }),
        ),
      );
    return yield* reviewOf(resolved);
  });
  return Approvals.of({ review, approve, revoke });
});
export const layer = Layer.effect(Approvals, make);
