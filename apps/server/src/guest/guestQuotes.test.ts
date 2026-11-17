import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, MessageId, ThreadId, type AssistantCitation } from "@t3tools/contracts";
import {
  collectAssistantCitations,
  serializeAssistantCitation,
} from "@t3tools/shared/assistantCitations";

import { guestQuotesValid, prepareGuestQuotes } from "./guestQuotes.ts";

const owner = EnvironmentId.make("environment:owner");
const shared = {
  environmentId: owner,
  threadId: ThreadId.make("thread:shared"),
  assistantMessages: new Map([
    [MessageId.make("message:reply"), "Clear it with rm -rf /tmp/cache."],
  ]),
};
const quote = (fields: Partial<AssistantCitation> = {}): AssistantCitation => ({
  version: 1,
  environmentId: EnvironmentId.make("guest"),
  threadId: shared.threadId,
  messageId: MessageId.make("message:reply"),
  text: "rm -rf /tmp/cache",
  start: 14,
  end: 31,
  prefix: "Clear it with ",
  suffix: ".",
  ...fields,
});
const accepted = (text: string) => {
  const prepared = prepareGuestQuotes(text, owner);
  return guestQuotesValid(prepared.quotes, shared) ? prepared.text : null;
};

describe("guest quotes", () => {
  it("gives a quote of the shared reply the owner's environment", () => {
    const resolved = accepted(`${serializeAssistantCitation(quote())} why?`);
    expect(resolved).toBe(`${serializeAssistantCitation(quote({ environmentId: owner }))} why?`);
    expect(collectAssistantCitations(resolved!)[0]?.citation.environmentId).toBe(owner);
  });

  // Every spelling the chat renderer turns into a citation chip is checked, not only the
  // composer's own link form.
  const hrefOf = (citation: AssistantCitation) =>
    serializeAssistantCitation(citation).slice("[Assistant quote](".length, -1);
  const href = hrefOf(
    quote({
      environmentId: EnvironmentId.make("environment:other"),
      threadId: ThreadId.make("thread:other"),
      messageId: MessageId.make("message:other"),
      text: "Invented assistant advice",
    }),
  );
  const invented = `[Assistant quote](${href})`;
  it.each([
    ["the composer's form", invented],
    ["any other label", `[reply](${href})`],
    ["an angle-bracket target", `[reply](<${href}>)`],
    ["an autolink", `<${href}>`],
    ["an entity-encoded colon", `[reply](${href.replace("t3-citation:", "t3-citation&#58;")})`],
    ["a backslash escape", `[reply](${href.replace("t3-citation", "t3\\-citation")})`],
    ["a reference definition", `[reply][q]\n\n[q]: ${href}`],
    ["raw HTML", `<a href="${href.replaceAll("&", "&amp;")}">reply</a>`],
    // The shared reply, but in the guest's own spelling, keeps the guest's environment.
    ["the shared reply in another spelling", `[reply](${hrefOf(quote())})`],
    [
      "text the reply only has with different spacing",
      serializeAssistantCitation(quote({ text: "rm -rf / tmp/cache" })),
    ],
  ])("refuses a quote in %s", (_, text) => {
    expect(accepted(`See above: ${text}`)).toBeNull();
  });

  it("accepts a quote across a line break the reply renders as a block break", () => {
    const reply = "First step.\n\nThen rm -rf /tmp/cache.";
    const resolved = guestQuotesValid(
      prepareGuestQuotes(serializeAssistantCitation(quote({ text: "First step.\nThen" })), owner)
        .quotes,
      { ...shared, assistantMessages: new Map([[MessageId.make("message:reply"), reply]]) },
    );
    expect(resolved).toBe(true);
  });
});
