import { describe, expect, it } from "vite-plus/test";

import {
  formatReviewFindingsMarkdown,
  readReviewFindingsReport,
  reviewFindingsHeading,
} from "./reviewFindings.ts";

describe("readReviewFindingsReport", () => {
  it("reads findings and drops entries without a file or summary", () => {
    const report = readReviewFindingsReport({
      level: "medium",
      findings: [
        {
          file: "src/gateway.ts",
          line: 25,
          summary: "The log row is written after the call returns.",
          failure_scenario: "The process dies mid-call.",
          verdict: "PLAUSIBLE",
          outcome: "no_change_needed",
        },
        { file: "src/other.ts" },
        { summary: "No file" },
      ],
    });
    expect(report).toEqual({
      findings: [
        {
          file: "src/gateway.ts",
          line: 25,
          summary: "The log row is written after the call returns.",
          shortSummary: undefined,
          failureScenario: "The process dies mid-call.",
          category: undefined,
          verdict: "plausible",
          outcome: "no_change_needed",
        },
      ],
    });
  });

  it("treats an empty findings array as a report and a missing one as none", () => {
    expect(readReviewFindingsReport({ findings: [] })).toEqual({ findings: [] });
    expect(readReviewFindingsReport({})).toBeUndefined();
    expect(reviewFindingsHeading({ findings: [] })).toBe("Code review found no issues");
  });
});

describe("formatReviewFindingsMarkdown", () => {
  it("numbers findings with a linked location and indents their prose under the item", () => {
    const report = readReviewFindingsReport({
      findings: [
        {
          file: "app/Services/Logging Gateway.php",
          line: 25,
          summary: "The log row is written after the call returns.",
          short_summary: "Log row written too late",
          failure_scenario: "A container is redeployed mid-call.\nThe log misses the send.",
          category: "correctness",
          verdict: "CONFIRMED",
        },
        { file: "README.md", summary: "Stale `setup` step." },
      ],
    })!;
    expect(formatReviewFindingsMarkdown(report)).toBe(
      [
        "1. **Log row written too late**",
        "",
        "   [app/Services/Logging Gateway.php:25](<app/Services/Logging Gateway.php#L25>) · correctness · confirmed",
        "",
        "   The log row is written after the call returns.",
        "",
        "   *Failure scenario:* A container is redeployed mid-call.",
        "   The log misses the send.",
        "",
        "2. **Stale `setup` step.**",
        "",
        "   [README.md](<README.md>)",
      ].join("\n"),
    );
  });
});
