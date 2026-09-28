/**
 * Code-review findings reported through Claude Code's `ReportFindings` tool.
 *
 * The tool's input is the review's deliverable: the agent's closing message
 * only points back at it ("the findings above"). Clients render it as a card
 * instead of a tool row, so this module reads the projected input and formats
 * it as markdown that each client's own renderer turns into file links.
 */

export const REPORT_FINDINGS_TOOL_NAME = "ReportFindings";

export type ReviewFindingVerdict = "confirmed" | "plausible";
export type ReviewFindingOutcome = "fixed" | "skipped" | "no_change_needed";

export interface ReviewFinding {
  readonly file: string;
  readonly line: number | undefined;
  readonly summary: string;
  readonly shortSummary: string | undefined;
  readonly failureScenario: string | undefined;
  readonly category: string | undefined;
  readonly verdict: ReviewFindingVerdict | undefined;
  readonly outcome: ReviewFindingOutcome | undefined;
}

export interface ReviewFindingsReport {
  readonly findings: ReadonlyArray<ReviewFinding>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function isReportFindingsToolName(toolName: string | null | undefined): boolean {
  return toolName?.trim() === REPORT_FINDINGS_TOOL_NAME;
}

function readVerdict(value: unknown): ReviewFindingVerdict | undefined {
  const verdict = asTrimmedString(value)?.toLowerCase();
  return verdict === "confirmed" || verdict === "plausible" ? verdict : undefined;
}

function readOutcome(value: unknown): ReviewFindingOutcome | undefined {
  const outcome = asTrimmedString(value);
  return outcome === "fixed" || outcome === "skipped" || outcome === "no_change_needed"
    ? outcome
    : undefined;
}

function readFinding(value: unknown): ReviewFinding | undefined {
  const record = asRecord(value);
  const file = asTrimmedString(record?.file);
  const summary = asTrimmedString(record?.summary);
  if (!record || !file || !summary) {
    return undefined;
  }
  const line =
    typeof record.line === "number" && Number.isInteger(record.line) && record.line > 0
      ? record.line
      : undefined;
  return {
    file,
    line,
    summary,
    shortSummary: asTrimmedString(record.short_summary),
    failureScenario: asTrimmedString(record.failure_scenario),
    category: asTrimmedString(record.category),
    verdict: readVerdict(record.verdict),
    outcome: readOutcome(record.outcome),
  };
}

/**
 * The report in a `ReportFindings` input, or undefined when the input has no
 * findings array. An empty array is a real report: the review found nothing.
 */
export function readReviewFindingsReport(input: unknown): ReviewFindingsReport | undefined {
  const record = asRecord(input);
  if (!record || !Array.isArray(record.findings)) {
    return undefined;
  }
  return {
    findings: record.findings.flatMap((entry) => {
      const finding = readFinding(entry);
      return finding ? [finding] : [];
    }),
  };
}

export function reviewFindingsHeading(report: ReviewFindingsReport): string {
  const count = report.findings.length;
  if (count === 0) {
    return "Code review found no issues";
  }
  return count === 1 ? "Code review found 1 issue" : `Code review found ${count.toString()} issues`;
}

const OUTCOME_LABELS: Readonly<Record<ReviewFindingOutcome, string>> = {
  fixed: "fixed",
  skipped: "skipped",
  no_change_needed: "no change needed",
};

function escapeLinkLabel(value: string): string {
  return value.replace(/[[\]\\]/gu, (character) => `\\${character}`);
}

function indentContinuation(text: string, indent: string): string {
  return text
    .split("\n")
    .map((line) => (line.trim().length > 0 ? `${indent}${line}` : ""))
    .join("\n");
}

function formatFinding(finding: ReviewFinding, index: number): string {
  const marker = `${(index + 1).toString()}. `;
  const indent = " ".repeat(marker.length);
  const location =
    finding.line === undefined ? finding.file : `${finding.file}:${finding.line.toString()}`;
  const href =
    finding.line === undefined ? finding.file : `${finding.file}#L${finding.line.toString()}`;
  const meta = [
    `[${escapeLinkLabel(location)}](<${href}>)`,
    finding.category,
    finding.verdict,
    finding.outcome ? OUTCOME_LABELS[finding.outcome] : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join(" · ");

  const title = finding.shortSummary ?? finding.summary;
  const blocks = [`${marker}**${title.replace(/\s+/gu, " ")}**`, `${indent}${meta}`];
  if (finding.shortSummary) {
    blocks.push(indentContinuation(finding.summary, indent));
  }
  if (finding.failureScenario) {
    blocks.push(indentContinuation(`*Failure scenario:* ${finding.failureScenario}`, indent));
  }
  return blocks.join("\n\n");
}

/**
 * The findings as a numbered markdown list, most severe first as reported.
 * Locations are relative links with `#L` anchors, which both clients' markdown
 * renderers resolve against the thread's workspace.
 */
export function formatReviewFindingsMarkdown(report: ReviewFindingsReport): string {
  return report.findings.map(formatFinding).join("\n\n");
}
