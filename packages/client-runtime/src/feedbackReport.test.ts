import { describe, expect, it } from "vite-plus/test";

import { feedbackReportDeclineOptions, feedbackReportFromApproval } from "./feedbackReport.ts";

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

describe("feedbackReportDeclineOptions", () => {
  it("keeps every option except posting", () => {
    expect(
      feedbackReportDeclineOptions([
        { decision: "accept", label: "Post publicly" },
        { decision: "decline", label: "Don't post" },
      ]),
    ).toEqual([{ decision: "decline", label: "Don't post" }]);
  });
});
