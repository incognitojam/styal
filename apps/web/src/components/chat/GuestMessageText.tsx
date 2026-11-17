import { collectAssistantCitations } from "@t3tools/shared/assistantCitations";
import type { ReactNode } from "react";

import { AssistantCitationChip } from "./AssistantCitationChip";

/** A guest message's text as written, with each quote it holds as a citation chip. */
export function GuestMessageText({ text }: { readonly text: string }) {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const { citation, start, end } of collectAssistantCitations(text)) {
    parts.push(
      text.slice(cursor, start),
      <AssistantCitationChip key={start} citation={citation} />,
    );
    cursor = end;
  }
  parts.push(text.slice(cursor));
  return parts;
}
