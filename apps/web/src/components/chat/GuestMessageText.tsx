import type { ThreadGuestMessage } from "@t3tools/contracts";

import { AssistantCitationChip } from "./AssistantCitationChip";

/** A guest message's quotes as citation chips, then the guest's own text. */
export function GuestMessageText({
  message,
}: {
  readonly message: Pick<ThreadGuestMessage, "text" | "quotes">;
}) {
  return (
    <>
      {message.quotes?.map((quote, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- a message's quotes never change
        <AssistantCitationChip key={index} citation={quote} />
      ))}
      {(message.quotes?.length ?? 0) > 0 && message.text ? " " : null}
      {message.text}
    </>
  );
}
