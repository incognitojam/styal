import * as Schema from "effect/Schema";
import { ProjectId, ThreadId, IsoDateTime } from "./baseSchemas.ts";

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
export const WorktreeCleanupApprovals = Schema.Record(
  Schema.String,
  Schema.Record(Schema.String, Schema.Struct({ approvedAt: IsoDateTime })),
);
export const WorktreeCleanupApproveInput = Schema.Struct({
  projectId: ProjectId,
  patterns: Schema.Array(Schema.String.check(Schema.isMaxLength(1024))).check(
    Schema.isMaxLength(100),
  ),
});
export type WorktreeCleanupApproveInput = typeof WorktreeCleanupApproveInput.Type;
export const WorktreeCleanupRevokeInput = Schema.Struct({
  projectId: ProjectId,
  pattern: Schema.NullOr(Schema.String.check(Schema.isMaxLength(1024))),
});
export type WorktreeCleanupRevokeInput = typeof WorktreeCleanupRevokeInput.Type;
export const WorktreeCleanupReview = Schema.Struct({
  status: Schema.Literals(["none", "pending", "approved"]),
  declared: Schema.Array(
    Schema.Struct({ pattern: Schema.String, status: Schema.Literals(["approved", "pending"]) }),
  ),
  approvedNotDeclared: Schema.Array(
    Schema.Struct({ pattern: Schema.String, approvedAt: IsoDateTime }),
  ),
});
export type WorktreeCleanupReview = typeof WorktreeCleanupReview.Type;
export const WorktreeCleanupApproveResult = Schema.Struct({
  ...WorktreeCleanupReview.fields,
  notDeclared: Schema.Array(Schema.String),
});
export type WorktreeCleanupApproveResult = typeof WorktreeCleanupApproveResult.Type;
export const WorktreeCleanupPreviewInput = Schema.Struct({
  projectId: ProjectId,
  list: Schema.Literals(["approved", "declared"]),
});
export type WorktreeCleanupPreviewInput = typeof WorktreeCleanupPreviewInput.Type;
export const WorktreeCleanupSelected = Schema.Struct({
  path: Schema.String,
  pattern: Schema.String,
  patterns: Schema.Array(Schema.String),
  patternStatus: Schema.Literals(["approved", "pending"]),
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
    "too-large-to-verify",
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
  entriesTruncated: Schema.Boolean,
  measurementComplete: Schema.Boolean,
});
export type WorktreeCleanupPreviewEntry = typeof WorktreeCleanupPreviewEntry.Type;
export const WorktreeCleanupPreview = Schema.Struct({
  review: WorktreeCleanupReview,
  patterns: Schema.Array(Schema.String),
  worktrees: Schema.Array(WorktreeCleanupPreviewEntry),
  worktreesTruncated: Schema.Boolean,
});
export type WorktreeCleanupPreview = typeof WorktreeCleanupPreview.Type;
