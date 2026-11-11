import type { ThreadGuestMessage } from "@t3tools/contracts";

import { AssistantCitationEmbed } from "./AssistantCitationChip";

/** A guest message's quotes as quote cards, then the guest's own text. */
export function GuestMessageText({
  message,
}: {
  readonly message: Pick<ThreadGuestMessage, "text" | "quotes">;
}) {
  return (
    <>
      {message.quotes?.map((quote, index, quotes) => (
        <AssistantCitationEmbed
          // oxlint-disable-next-line react/no-array-index-key -- a message's quotes never change
          key={index}
          citation={quote}
          leading={index === 0}
          trailing={index === quotes.length - 1 && !message.text}
        />
      ))}
      {message.text}
    </>
  );
}
