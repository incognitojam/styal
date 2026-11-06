import { describe, expect, it } from "vite-plus/test";

import {
  feedbackReportDeclineOptions,
  feedbackReportFromApproval,
  isAnsweredFeedbackReportApproval,
} from "./feedbackReport.ts";

const report = {
  title: "A title",
  body: "A body",
  repository: "incognitojam/styal",
  account: "octocat",
};

describe("feedbackReportFromApproval", () => {
  it("reads the report from the report tool's approval", () => {
    expect(
      feedbackReportFromApproval({ toolName: "report_styal_issue", toolInput: report }),
    ).toEqual(report);
  });

  it("leaves other approvals, and malformed input, as ordinary approvals", () => {
    expect(feedbackReportFromApproval({ toolName: "hardware_call", toolInput: report })).toBeNull();
    expect(
      feedbackReportFromApproval({ toolName: "report_styal_issue", toolInput: { title: "x" } }),
    ).toBeNull();
    expect(feedbackReportFromApproval({})).toBeNull();
  });
});

describe("isAnsweredFeedbackReportApproval", () => {
  it.each([
    { status: "completed", toolName: "report_styal_issue", expected: true },
    { status: "cancelled", toolName: "report_styal_issue", expected: true },
    { status: "waiting", toolName: "report_styal_issue", expected: false },
    { status: "completed", toolName: "hardware_call", expected: false },
  ])("$toolName $status is $expected", ({ status, toolName, expected }) => {
    expect(isAnsweredFeedbackReportApproval({ type: "approval_request", status, toolName })).toBe(
      expected,
    );
  });

  it("ignores the report tool's own row", () => {
    expect(
      isAnsweredFeedbackReportApproval({
        type: "dynamic_tool",
        status: "completed",
        toolName: "report_styal_issue",
      }),
    ).toBe(false);
  });
});

describe("feedbackReportDeclineOptions", () => {
  it("keeps every option except posting", () => {
    expect(
      feedbackReportDeclineOptions([
        { decision: "accept", label: "Post publicly" },
        { decision: "decline", label: "Don't send" },
      ]),
    ).toEqual([{ decision: "decline", label: "Don't send" }]);
  });
});
