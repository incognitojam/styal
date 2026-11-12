import {
  FeedbackAgentReportResult,
  FeedbackDraft,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as FeedbackService from "../../../feedback/FeedbackService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  FeedbackService.FeedbackService,
];

const ReportIssueTool = Tool.make("report_styal_issue", {
  description:
    "File a public GitHub issue about styal itself, never the user's project, when the user wants to report a styal bug or send styal feedback. Write what happened, the steps, and what you expected; one bug or request per issue. Check any suggested fix or wording against the code and docs, and mark guesses as guesses. Leave out paths, secrets, private code and names: it is public under the user's account. styal adds a footer with the version and author. The user approves the exact text in a card; do not ask first. If `not_filed`, give the user `manualUrl`.",
  parameters: FeedbackDraft,
  success: FeedbackAgentReportResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Report a styal issue")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

export const FeedbackToolkit = Toolkit.make(ReportIssueTool);
