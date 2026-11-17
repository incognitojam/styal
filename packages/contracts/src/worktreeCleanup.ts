import * as Schema from "effect/Schema";
import { ProjectId } from "./baseSchemas.ts";

export class WorktreeCleanupError extends Schema.TaggedError<WorktreeCleanupError>()(
  "WorktreeCleanupError",
  {
    reason: Schema.Literals(["project-not-found", "run-failed"]),
    message: Schema.String,
  },
) {}
export const WorktreeCleanupReviewInput = Schema.Struct({ projectId: ProjectId });
export const WorktreeCleanupReview = Schema.Struct({
  patterns: Schema.Array(Schema.String),
  unavailableReason: Schema.optionalKey(Schema.String),
});
