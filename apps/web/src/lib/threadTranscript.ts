import { resolveUserMessagePresentation } from "@t3tools/client-runtime/user-message";
import type { ChatAttachment, OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import { upgradeLegacyContextMessage } from "@t3tools/shared/composerContextLegacy";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";

import { extractTrailingIssueContexts } from "./issueContext";

export interface ThreadTranscript {
  readonly text: string;
  /** Messages included after filtering; 0 means there is nothing worth copying. */
  readonly messageCount: number;
}

function attachmentSummary(attachments: ReadonlyArray<ChatAttachment>): string | null {
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

function section(
  author: string,
  text: string,
  attachments: ReadonlyArray<ChatAttachment>,
): string | null {
  const body = [text, attachmentSummary(attachments)]
    .filter((part) => part !== null && part.length > 0)
    .join("\n\n");
  return body.length === 0 ? null : `## ${author}\n\n${body}`;
}

/**
 * Reads the same projected turn items the timeline renders, so the server decides what is a
 * message: completions that woke the agent arrive as notification items and are left out. A
 * message still streaming is skipped rather than copied half-done.
 */
export function buildThreadTranscript(
  title: string,
  visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): ThreadTranscript {
  const sections: string[] = [];
  for (const { item } of visibleTurnItems) {
    let rendered: string | null = null;
    if (item.type === "user_message") {
      const presentation = resolveUserMessagePresentation({
        id: item.messageId,
        role: "user",
        text: item.text,
        createdBy: item.createdBy,
        scheduledTaskId: item.scheduledTaskId,
      });
      // Prompts can end with an issue block the composer appended at send time, and messages
      // sent before inline context references end with terminal and element blocks. The
      // transcript takes the text the user actually wrote, as the timeline renders it.
      // Attribution matches the label the timeline shows above the message.
      const author =
        presentation.attribution === "automation"
          ? "Automation"
          : presentation.attribution === "agent"
            ? "Another agent"
            : "User";
      rendered = section(author, visibleUserText(presentation.text), item.attachments);
    } else if (item.type === "assistant_message" && !item.streaming) {
      rendered = section("Assistant", item.text.trim(), item.attachments ?? []);
    }
    if (rendered !== null) {
      sections.push(rendered);
    }
  }
  const trimmedTitle = title.trim();
  const parts = trimmedTitle.length > 0 ? [`# ${trimmedTitle}`, ...sections] : sections;
  return { text: parts.join("\n\n"), messageCount: sections.length };
}
