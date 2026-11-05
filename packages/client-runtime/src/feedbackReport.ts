import {
  FEEDBACK_REPORT_TOOL_NAME,
  FeedbackApprovalReport,
  type ProviderApprovalOption,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isReport = Schema.is(FeedbackApprovalReport);

/** The report behind an approval card, or null for any other approval. */
export const feedbackReportFromApproval = (approval: {
  readonly toolName?: string;
  readonly toolInput?: unknown;
}): FeedbackApprovalReport | null =>
  approval.toolName === FEEDBACK_REPORT_TOOL_NAME && isReport(approval.toolInput)
    ? approval.toolInput
    : null;

/** Posting is offered only where the report is on screen. */
export const feedbackReportDeclineOptions = (
  options: ReadonlyArray<ProviderApprovalOption> | undefined,
) => (options ?? []).filter((option) => option.decision !== "accept");
