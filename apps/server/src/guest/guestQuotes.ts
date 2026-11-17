import type { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import {
  collectAssistantCitations,
  serializeAssistantCitation,
} from "@t3tools/shared/assistantCitations";
import { searchableMessageSegments } from "@t3tools/shared/threadFindText";

/** The assistant messages a guest's quotes name, as the shared thread stores them. */
export function guestQuotedMessageIds(text: string): ReadonlyArray<MessageId> {
  return [...new Set(collectAssistantCitations(text).map(({ citation }) => citation.messageId))];
}

const withoutWhitespace = (text: string) => text.replace(/\s+/g, "");

/**
 * Whether a guest's quote is text the message shows. The page quotes rendered text, so the check
 * runs against the rendered text and, for what renders differently from its source (such as a
 * formula), the Markdown. Whitespace is ignored, since block breaks render as line breaks.
 */
function quotesMessage(quote: string, markdown: string): boolean {
  const target = withoutWhitespace(quote);
  const rendered = searchableMessageSegments({
    role: "assistant",
    text: markdown,
    streaming: false,
  });
  return (
    withoutWhitespace((rendered ?? []).join("")).includes(target) ||
    withoutWhitespace(markdown).includes(target)
  );
}

/**
 * A guest's message with its quotes checked against the shared thread, or null when one quotes
 * anything else. The page cannot know the owner's environment, so each quote gets it here.
 */
export function resolveGuestQuotes(
  text: string,
  shared: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    /** The Markdown of the thread's assistant messages that the quotes name. */
    readonly assistantMessages: ReadonlyMap<MessageId, string>;
  },
): string | null {
  let resolved = "";
  let cursor = 0;
  for (const { citation, start, end } of collectAssistantCitations(text)) {
    const markdown = shared.assistantMessages.get(citation.messageId);
    if (
      citation.threadId !== shared.threadId ||
      markdown === undefined ||
      !quotesMessage(citation.text, markdown)
    ) {
      return null;
    }
    resolved += text.slice(cursor, start);
    resolved += serializeAssistantCitation({ ...citation, environmentId: shared.environmentId });
    cursor = end;
  }
  return resolved + text.slice(cursor);
}
