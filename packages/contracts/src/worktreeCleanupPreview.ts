import * as Schema from "effect/Schema";
import { ProjectId, ThreadId } from "./baseSchemas.ts";

export class WorktreeCleanupError extends Schema.TaggedError<WorktreeCleanupError>()(
  "WorktreeCleanupError",
  {
    reason: Schema.Literals([
      "project-not-found",
      "nothing-to-approve",
      "save-failed",
      "run-failed",
    ]),
    message: Schema.String,
  },
) {}
export const WorktreeCleanupReviewInput = Schema.Struct({ projectId: ProjectId });
export const WorktreeCleanupReview = Schema.Struct({
  status: Schema.Literals(["none", "unapproved", "changed", "approved"]),
  patterns: Schema.Array(Schema.String),
  previouslyApprovedPatterns: Schema.NullOr(Schema.Array(Schema.String)),
});
export type WorktreeCleanupReview = typeof WorktreeCleanupReview.Type;
export const WorktreeCleanupPreviewInput = Schema.Struct({
  projectId: ProjectId,
  list: Schema.Literals(["approved", "declared"]),
});
export type WorktreeCleanupPreviewInput = typeof WorktreeCleanupPreviewInput.Type;
export const WorktreeCleanupSelected = Schema.Struct({
  path: Schema.String,
  pattern: Schema.String,
  kind: Schema.Literals(["file", "directory"]),
  freedBytes: Schema.NullOr(Schema.Number),
});
export type WorktreeCleanupSelected = typeof WorktreeCleanupSelected.Type;
export const WorktreeCleanupKept = Schema.Struct({
  path: Schema.String,
  pattern: Schema.String,
  reason: Schema.Literals([
    "not-ignored",
    "contains-tracked-files",
    "symbolic-link",
    "mount-point",
    "nested-checkout",
  ]),
  detail: Schema.optionalKey(Schema.String),
});
export type WorktreeCleanupKept = typeof WorktreeCleanupKept.Type;
export const WorktreeCleanupPreviewEntry = Schema.Struct({
  worktreePath: Schema.String,
  threadCount: Schema.Number,
  status: Schema.Literals(["eligible", "kept"]),
  reason: Schema.optionalKey(
    Schema.Literals(["not-managed-worktree", "unsettled-thread", "missing", "symbolic-link"]),
  ),
  holdingThread: Schema.optionalKey(Schema.Struct({ id: ThreadId, title: Schema.String })),
  selected: Schema.Array(WorktreeCleanupSelected),
  kept: Schema.Array(WorktreeCleanupKept),
  freedBytes: Schema.NullOr(Schema.Number),
  truncated: Schema.Boolean,
});
export type WorktreeCleanupPreviewEntry = typeof WorktreeCleanupPreviewEntry.Type;
export const WorktreeCleanupPreview = Schema.Struct({
  review: WorktreeCleanupReview,
  patterns: Schema.Array(Schema.String),
  worktrees: Schema.Array(WorktreeCleanupPreviewEntry),
  truncated: Schema.Boolean,
});
export type WorktreeCleanupPreview = typeof WorktreeCleanupPreview.Type;
