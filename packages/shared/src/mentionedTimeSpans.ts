/**
 * Clock-like spans in an agent message's markdown, found the same way on the server, which asks a
 * model what each one is, and in the client, which applies the answers to its time chips. Offsets
 * are into the raw markdown. Code is skipped because a time inside code belongs to something else.
 */
import type { OrchestrationV2ConversationMessage } from "@t3tools/contracts";

export interface MentionedTimeSpan {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

const CODE = /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]+`/g;
const CLOCK_LIKE =
  /(?<![\w:./#-])\d{1,2}:[0-5]\d(?::[0-5]\d)?(?:\.\d+)?(?:\s?[AaPp]\.?[Mm]\.?(?!\w))?(?![\w:]|\.\d)|\b\d{1,2}\s?[AaPp]\.?[Mm]\.?(?!\w)|\b(?:noon|midnight)\b/gi;

export function findMentionedTimeSpans(markdown: string): MentionedTimeSpan[] {
  const code: [number, number][] = [];
  for (const match of markdown.matchAll(CODE)) {
    code.push([match.index, match.index + match[0].length]);
  }
  const spans: MentionedTimeSpan[] = [];
  for (const match of markdown.matchAll(CLOCK_LIKE)) {
    const start = match.index;
    const end = start + match[0].length;
    if (code.some(([from, to]) => start < to && end > from)) continue;
    spans.push({ start, end, text: match[0] });
  }
  return spans;
}

/**
 * The markdown with each span tagged for a model as `[s1]⟦17:25⟧`. The tag sits outside the
 * brackets: `⟦1:17:25⟧` reads as an elapsed timer.
 */
export function markMentionedTimeSpans(
  markdown: string,
  spans: readonly MentionedTimeSpan[],
): string {
  let marked = "";
  let cursor = 0;
  spans.forEach((span, index) => {
    marked += `${markdown.slice(cursor, span.start)}[s${index + 1}]⟦${span.text}⟧`;
    cursor = span.end;
  });
  return marked + markdown.slice(cursor);
}

/** A re-sent message keeps the model's reading of its times while its text is unchanged. */
export function keepMentionedTimes(
  previous: OrchestrationV2ConversationMessage | undefined,
  next: OrchestrationV2ConversationMessage,
): OrchestrationV2ConversationMessage {
  if (
    next.mentionedTimes !== undefined ||
    previous?.mentionedTimes === undefined ||
    previous.text !== next.text
  ) {
    return next;
  }
  return { ...next, mentionedTimes: previous.mentionedTimes };
}
