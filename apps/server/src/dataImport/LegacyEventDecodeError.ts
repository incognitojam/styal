import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

export class OrchestrationProjectorDecodeError extends Schema.TaggedError<OrchestrationProjectorDecodeError>()(
  "LegacyEventDecodeError",
  { eventType: Schema.String, issue: Schema.String, cause: Schema.Defect() },
) {}

export const toProjectorDecodeError = (eventType: string) => (cause: Schema.SchemaError) =>
  new OrchestrationProjectorDecodeError({
    eventType,
    issue: SchemaIssue.makeFormatterDefault()(cause.issue),
    cause,
  });
