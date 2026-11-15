import * as Schema from "effect/Schema";
import { ProjectId, IsoDateTime } from "./baseSchemas.ts";

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
