import * as Schema from "effect/Schema";
import { EventId, ThreadId } from "./baseSchemas.ts";

/** The activity id names a V2 command item or a retained V1 activity. */
export const OrchestrationGetCommandOutputInput = Schema.Struct({
  threadId: ThreadId,
  activityId: EventId,
});
export type OrchestrationGetCommandOutputInput = typeof OrchestrationGetCommandOutputInput.Type;
export const OrchestrationGetCommandOutputResult = Schema.Struct({
  status: Schema.Literals(["available", "unavailable"]),
  output: Schema.NullOr(Schema.String),
  stdout: Schema.NullOr(Schema.String),
  stderr: Schema.NullOr(Schema.String),
  exitCode: Schema.NullOr(Schema.Int),
});
export type OrchestrationGetCommandOutputResult = typeof OrchestrationGetCommandOutputResult.Type;
export class OrchestrationGetCommandOutputError extends Schema.TaggedError<OrchestrationGetCommandOutputError>()(
  "OrchestrationGetCommandOutputError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}
