import type { OrchestrationMessage } from "@t3tools/contracts";
import { upgradeLegacyContextMessage } from "@t3tools/shared/composerContextLegacy";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";

import { extractTrailingIssueContexts } from "./issueContext";

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
  const attachments = message.attachments ?? [];
  const count = attachments.length;
  if (count === 0) {
    return null;
  }
  const names = attachments.slice(0, 3).map((attachment) => attachment.name);
  const extraCount = count - names.length;
  const extraSummary = extraCount > 0 ? ` (+${extraCount} more)` : "";
  return `[Attached file${count === 1 ? "" : "s"}: ${names.join(", ")}${extraSummary}]`;
}

/** The prose the user wrote, with each inline context reference reduced to its label. */
function visibleUserText(text: string): string {
  const withoutIssues = extractTrailingIssueContexts(text).promptText;
  return replaceComposerContextReferences(
    upgradeLegacyContextMessage(withoutIssues).text,
    (reference) => reference.label,
  ).trim();
}

function messageBody(message: TranscriptMessage): string | null {
  // User prompts can end with an issue block the composer appended at send time, and messages
  // sent before inline context references end with terminal and element blocks. The transcript
  // takes the text the user actually wrote, as the timeline renders it.
  const text = message.role === "user" ? visibleUserText(message.text) : message.text.trim();
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
