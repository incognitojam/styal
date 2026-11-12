import { parseFeedbackFooter } from "@t3tools/shared/feedbackFooter";

export type ReportKind = ReturnType<typeof parseFeedbackFooter>;

// A complete visible footer must end the report or a GitHub issue-form section.
export const classifyReport = parseFeedbackFooter;

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
        title: Array.from(`#${issue.number}: ${issue.title}`).slice(0, 256).join(""),
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

export async function postDiscord(
  webhook: string,
  payload: ReturnType<typeof discordPayload>,
  request = fetch,
  wait = (milliseconds: number) =>
    // @effect-diagnostics-next-line globalTimers:off -- github-script runs this module without Effect installed.
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await request(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (response === null) return false;
    if (response.ok) return true;
    if (response.status !== 429) throw new Error(`Discord alert failed: ${response.status}`);
    if (attempt === 2) return false;
    const data: unknown = await response.json().catch(() => null);
    const retryAfter =
      typeof data === "object" && data !== null && "retry_after" in data
        ? data.retry_after
        : undefined;
    if (
      typeof retryAfter !== "number" ||
      !Number.isFinite(retryAfter) ||
      retryAfter < 0 ||
      retryAfter > 30
    )
      return false;
    await wait(Math.ceil(retryAfter * 1_000));
  }
  return false;
}
