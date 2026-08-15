import type { OrchestrationMessage } from "@t3tools/contracts";

import { deriveDisplayedUserMessageState } from "./terminalContext";

export type TranscriptMessage = Pick<
  OrchestrationMessage,
  "role" | "text" | "attachments" | "streaming"
>;

export interface ThreadTranscript {
  readonly text: string;
  /** Messages included after filtering; 0 means there is nothing worth copying. */
  readonly messageCount: number;
}

function attachmentSummary(message: TranscriptMessage): string | null {
  const imageAttachments = message.attachments?.filter((attachment) => attachment.type === "image");
  const count = imageAttachments?.length ?? 0;
  if (count === 0) {
    return null;
  }
  const names = imageAttachments?.slice(0, 3).map((image) => image.name) ?? [];
  const extraCount = count - names.length;
  const extraSummary = extraCount > 0 ? ` (+${extraCount} more)` : "";
  return `[Attached image${count === 1 ? "" : "s"}: ${names.join(", ")}${extraSummary}]`;
}

function messageBody(message: TranscriptMessage): string | null {
  // User prompts carry injected trailing context blocks (terminal, element,
  // issue) that the composer appended at send time; the transcript takes the
  // visible text the user actually wrote, same as the timeline renders.
  const text =
    message.role === "user"
      ? deriveDisplayedUserMessageState(message.text).visibleText.trim()
      : message.text.trim();
  const attachments = attachmentSummary(message);
  const body = [text, attachments].filter((part) => part !== null && part.length > 0).join("\n\n");
  return body.length === 0 ? null : body;
}

/**
 * Serialize a thread's conversation as markdown for sharing or pasting into a
 * new chat as context. Only user and assistant messages are included — tool
 * calls and reasoning live in thread activities, which are deliberately left
 * out — and a message still streaming is skipped rather than copied half-done.
 */
export function buildThreadTranscript(
  title: string,
  messages: ReadonlyArray<TranscriptMessage>,
): ThreadTranscript {
  const sections: string[] = [];
  for (const message of messages) {
    if (message.role === "system" || message.streaming) {
      continue;
    }
    const body = messageBody(message);
    if (body === null) {
      continue;
    }
    sections.push(`## ${message.role === "user" ? "User" : "Assistant"}\n\n${body}`);
  }
  const trimmedTitle = title.trim();
  const parts = trimmedTitle.length > 0 ? [`# ${trimmedTitle}`, ...sections] : sections;
  return { text: parts.join("\n\n"), messageCount: sections.length };
}
