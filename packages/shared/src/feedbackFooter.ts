const USER_AUTHOR = "Sent from styal by the user.";
const AGENT_AUTHOR = "Written by an agent";
const AGENT_APPROVAL = " and approved by the user.";

export function formatFeedbackFooter(input: {
  version: string;
  channel: string;
  platform: string;
  architecture: string;
  kind: "user" | "agent";
  agent?: string;
}) {
  const author =
    input.kind === "user"
      ? USER_AUTHOR
      : `${AGENT_AUTHOR}${input.agent === undefined ? "" : ` (${input.agent})`}${AGENT_APPROVAL}`;
  return `\n\n---\nstyal ${input.version} (${input.channel}), ${input.platform} ${input.architecture}\n${author}`;
}

export function parseFeedbackFooter(body: string | null | undefined) {
  const text = (body ?? "").replaceAll("\r\n", "\n").trimEnd();
  const author = /\n\n---\nstyal \S+ \([^()\r\n]+\), \S+ \S+\n([^\r\n]+)$/.exec(text)?.[1];
  if (author === USER_AUTHOR) return "user";
  if (author === `${AGENT_AUTHOR}${AGENT_APPROVAL}`) return "agent";
  if (
    author?.startsWith(`${AGENT_AUTHOR} (`) &&
    author.endsWith(`)${AGENT_APPROVAL}`) &&
    author.length > AGENT_AUTHOR.length + AGENT_APPROVAL.length + 3
  )
    return "agent";
  return "other";
}
