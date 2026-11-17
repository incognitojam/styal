import type { AssistantCitation, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import {
  collectAssistantCitations,
  parseAssistantCitationHref,
  serializeAssistantCitation,
} from "@t3tools/shared/assistantCitations";
import { chatMarkdownLinkTargets } from "@t3tools/shared/markdownPipeline";
import { searchableMessageSegments } from "@t3tools/shared/threadFindText";

/**
 * A guest's text with each quote in the composer's form given the owner's environment, which the
 * page cannot know, and every quote anything reads from it: the link form the composer writes,
 * and any other link spelling the chat renderer turns into a citation chip.
 */
export function prepareGuestQuotes(
  text: string,
  environmentId: EnvironmentId,
): { readonly text: string; readonly quotes: ReadonlyArray<AssistantCitation> } {
  let resolved = "";
  let cursor = 0;
  for (const { citation, start, end } of collectAssistantCitations(text)) {
    resolved += text.slice(cursor, start);
    resolved += serializeAssistantCitation({ ...citation, environmentId });
    cursor = end;
  }
  resolved += text.slice(cursor);
  return {
    text: resolved,
    quotes: [
      ...collectAssistantCitations(resolved).map(({ citation }) => citation),
      ...chatMarkdownLinkTargets(resolved).flatMap(
        (target) => parseAssistantCitationHref(target) ?? [],
      ),
    ],
  };
}

const collapseWhitespace = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * Whether a guest's quote is text the message shows. The page quotes rendered text, so the check
 * runs against the rendered text and, for what renders differently from its source (such as a
 * formula), the Markdown. Block breaks render as line breaks, so runs of whitespace compare equal,
 * but a word boundary must stay one.
 */
function quotesMessage(quote: string, markdown: string): boolean {
  const target = collapseWhitespace(quote);
  const rendered = searchableMessageSegments({
    role: "assistant",
    text: markdown,
    streaming: false,
  });
  return (
    collapseWhitespace((rendered ?? []).join(" ")).includes(target) ||
    collapseWhitespace(markdown).includes(target)
  );
}

/** Whether every quote is of an agent reply the shared thread shows its guest, in the owner's environment. */
export function guestQuotesValid(
  quotes: ReadonlyArray<AssistantCitation>,
  shared: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    /** The Markdown of the agent replies the guest sees that the quotes name. */
    readonly assistantMessages: ReadonlyMap<MessageId, string>;
  },
): boolean {
  return quotes.every((quote) => {
    const markdown = shared.assistantMessages.get(quote.messageId);
    return (
      quote.environmentId === shared.environmentId &&
      quote.threadId === shared.threadId &&
      markdown !== undefined &&
      quotesMessage(quote.text, markdown)
    );
  });
}
