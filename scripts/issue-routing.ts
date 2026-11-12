export type ReportKind = "agent" | "user" | "other";

// Standalone markers count anywhere so issue-form prefills survive surrounding fields.
// This is a routing hint, not authentication: anyone can imitate a report.
export function classifyReport(body: string | null | undefined): ReportKind {
  const text = (body ?? "").replaceAll("\r\n", "\n").trimEnd();
  const marker = /^<!-- styal-report: kind=(agent|user) version=[0-9A-Za-z.+-]+ -->$/m.exec(text);
  if (marker) return marker[1] as "agent" | "user";
  if (/(?:^|\n)Sent from styal by the user\.$/.test(text)) return "user";
  if (/(?:^|\n)Written by an agent(?: \([^()\n]+\))? and approved by the user\.$/.test(text)) {
    return "agent";
  }
  return "other";
}

export const routingLabels = [
  {
    name: "needs-triage",
    color: "fbca04",
    description: "Issue needs maintainer review and initial categorization.",
  },
  {
    name: "from-styal",
    color: "7057ff",
    description: "Reported through styal's in-app feedback tool.",
  },
  {
    name: "agent-report",
    color: "1d76db",
    description: "Agent-written feedback approved by the user.",
  },
  { name: "user-report", color: "0e8a16", description: "Feedback written by a user in styal." },
] as const;

export function issueLabels(kind: ReportKind): string[] {
  return kind === "other" ? ["needs-triage"] : ["needs-triage", "from-styal", `${kind}-report`];
}

export function discordPayload(
  issue: {
    number: number;
    title: string;
    html_url: string;
    user: { login: string } | null;
  },
  kind: ReportKind,
) {
  return {
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: `#${issue.number}: ${issue.title}`.slice(0, 256),
        url: issue.html_url,
        color: 7506394,
        fields: [
          { name: "Kind", value: kind === "other" ? "Not from styal" : `styal ${kind} report` },
          { name: "Author", value: issue.user?.login ?? "unknown" },
        ],
      },
    ],
  };
}
