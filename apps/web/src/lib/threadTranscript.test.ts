import {
  MessageId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
  RunId,
  ScheduledTaskId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { buildThreadTranscript } from "./threadTranscript";

type UserMessageItem = Extract<OrchestrationV2TurnItem, { type: "user_message" }>;
type AssistantMessageItem = Extract<OrchestrationV2TurnItem, { type: "assistant_message" }>;

const now = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
const threadId = ThreadId.make("thread-transcript");
let nextItem = 0;

function base() {
  const id = `item-${nextItem++}`;
  return {
    id: TurnItemId.make(id),
    threadId,
    runId: RunId.make("run-1"),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: nextItem,
    status: "completed" as const,
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
  };
}

function projected(item: OrchestrationV2TurnItem): OrchestrationV2ProjectedTurnItem {
  return {
    position: nextItem,
    visibility: "local",
    sourceThreadId: threadId,
    sourceItemId: item.id,
    item,
  };
}

function user(text: string, overrides: Partial<UserMessageItem> = {}) {
  const fields = base();
  return projected({
    ...fields,
    createdBy: "user",
    creationSource: "web",
    type: "user_message",
    messageId: MessageId.make(`message-${fields.id}`),
    inputIntent: "turn_start",
    text,
    attachments: [],
    ...overrides,
  });
}

function assistant(text: string, overrides: Partial<AssistantMessageItem> = {}) {
  const fields = base();
  return projected({
    ...fields,
    type: "assistant_message",
    messageId: MessageId.make(`message-${fields.id}`),
    text,
    streaming: false,
    ...overrides,
  });
}

describe("buildThreadTranscript", () => {
  it("serializes user and assistant messages as markdown sections under the title", () => {
    const transcript = buildThreadTranscript("Fix the login bug", [
      user("The login form crashes on submit."),
      assistant("Found it — the handler is missing.\n\nFixing now."),
    ]);
    expect(transcript.messageCount).toBe(2);
    expect(transcript.text).toBe(
      [
        "# Fix the login bug",
        "## User",
        "The login form crashes on submit.",
        "## Assistant",
        "Found it — the handler is missing.\n\nFixing now.",
      ].join("\n\n"),
    );
  });

  it("omits activity items, streaming messages, and empty messages", () => {
    const transcript = buildThreadTranscript("Title", [
      user("Investigate the hang"),
      projected({
        ...base(),
        type: "notification",
        source: { kind: "subagent" },
        outcome: "completed",
        summary: "Subagent finished",
        detail: "Found the root cause",
      }),
      projected({ ...base(), type: "reasoning", text: "thinking it over", streaming: false }),
      assistant("half an ans", { streaming: true }),
      assistant("   "),
    ]);
    expect(transcript.messageCount).toBe(1);
    expect(transcript.text).toBe(["# Title", "## User", "Investigate the hang"].join("\n\n"));
  });

  it("attributes messages sent by another agent or an automation", () => {
    const transcript = buildThreadTranscript("Title", [
      user("Rebase onto main", { createdBy: "agent", creationSource: "mcp" }),
      user("Run the nightly audit", { scheduledTaskId: ScheduledTaskId.make("task-1") }),
      user("[Triggered by schedule task: Audit]\n\nCheck the queue", {
        messageId: MessageId.make("scheduled-task-message:task-2:3:scheduled"),
        createdBy: "agent",
      }),
    ]);
    expect(transcript.text).toBe(
      [
        "# Title",
        "## Another agent",
        "Rebase onto main",
        "## Automation",
        "Run the nightly audit",
        "## Automation",
        "Check the queue",
      ].join("\n\n"),
    );
  });

  it("strips injected trailing context blocks from user prompts", () => {
    const transcript = buildThreadTranscript("Title", [
      user(
        "Why did the tests fail?\n\n<terminal_context>\n- Terminal 1 line 12:\n  12 | 1 failed\n</terminal_context>",
      ),
    ]);
    expect(transcript.text).toContain("Why did the tests fail?");
    expect(transcript.text).not.toContain("terminal_context");
    expect(transcript.text).not.toContain("1 failed");
  });

  it("summarizes attachments instead of dropping them", () => {
    const imageAttachment = {
      type: "image" as const,
      id: "att-1",
      name: "screenshot.png",
      mimeType: "image/png",
      sizeBytes: 1024,
    };
    const fileAttachment = {
      type: "file" as const,
      id: "att-2",
      name: "notes.md",
      mimeType: "text/markdown",
      sizeBytes: 128,
    };
    const transcript = buildThreadTranscript("Title", [
      user("See attached.", { attachments: [imageAttachment, fileAttachment] }),
      user("", { attachments: [imageAttachment] }),
    ]);
    expect(transcript.messageCount).toBe(2);
    expect(transcript.text).toContain(
      "See attached.\n\n[Attached files: screenshot.png, notes.md]",
    );
    expect(transcript.text).toContain("## User\n\n[Attached file: screenshot.png]");
  });

  it("returns an empty transcript when nothing survives filtering", () => {
    const transcript = buildThreadTranscript("Title", [assistant("", { streaming: true })]);
    expect(transcript.messageCount).toBe(0);
  });
});
