import {
  FEEDBACK_REPORT_TOOL_NAME,
  FeedbackApprovalReport,
  type ProviderApprovalOption,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isReport = Schema.is(FeedbackApprovalReport);

export const FEEDBACK_REPORT_TITLE = "Send feedback to styal";
export const FEEDBACK_REPORT_OPEN_ACTION = "Preview";

export const feedbackReportDescription = (report: FeedbackApprovalReport) =>
  `The agent would like to send feedback to the styal maintainers. It will be posted as a public GitHub issue on ${report.repository}, from the account @${report.account}. Below is exactly what will be posted. Read it, then choose whether to post it. Nothing has been shared yet.`;

/** The report behind an approval card, or null for any other approval. */
export const feedbackReportFromApproval = (approval: {
  readonly toolName?: string;
  readonly toolInput?: unknown;
}): FeedbackApprovalReport | null =>
  approval.toolName === FEEDBACK_REPORT_TOOL_NAME && isReport(approval.toolInput)
    ? approval.toolInput
    : null;

/**
 * An answered request adds no row: its tool row already holds the report text and the outcome,
 * and the request's prompt repeats that text in full.
 */
export const isAnsweredFeedbackReportApproval = (item: {
  readonly type: string;
  readonly status: string;
  readonly toolName?: string | null | undefined;
}): boolean =>
  item.type === "approval_request" &&
  item.toolName === FEEDBACK_REPORT_TOOL_NAME &&
  item.status !== "waiting";

/** Posting is offered only where the report is on screen. */
export const feedbackReportDeclineOptions = (
  options: ReadonlyArray<ProviderApprovalOption> | undefined,
) => (options ?? []).filter((option) => option.decision !== "accept");
