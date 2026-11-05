import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

// Hardcoded so a report can never land on upstream or on the repository an agent is working in.
export const FEEDBACK_REPOSITORY = "incognitojam/styal";

const FeedbackTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
// GitHub caps an issue body at 65536 characters; this leaves room for the diagnostics footer.
const FeedbackBody = TrimmedNonEmptyString.check(Schema.isMaxLength(60_000));

export const FeedbackDraft = Schema.Struct({
  title: FeedbackTitle,
  body: FeedbackBody,
});
export type FeedbackDraft = typeof FeedbackDraft.Type;

export const FeedbackFiled = Schema.Struct({
  status: Schema.Literal("filed"),
  issueUrl: Schema.String,
});

/** `manualUrl` opens the issue form with the report filled in, for the user to send themselves. */
export const FeedbackNotFiled = Schema.Struct({
  status: Schema.Literal("not_filed"),
  reason: Schema.String,
  manualUrl: Schema.String,
});

export const FeedbackSubmitResult = Schema.Union([FeedbackFiled, FeedbackNotFiled]);
export type FeedbackSubmitResult = typeof FeedbackSubmitResult.Type;

export const FeedbackAgentReportResult = Schema.Union([
  FeedbackFiled,
  FeedbackNotFiled,
  Schema.Struct({ status: Schema.Literal("declined") }),
  Schema.Struct({ status: Schema.Literal("not_answered") }),
]);
export type FeedbackAgentReportResult = typeof FeedbackAgentReportResult.Type;
