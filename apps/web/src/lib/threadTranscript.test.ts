import { NodeId, RunId, ScheduledTaskId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildThreadTranscript, type TranscriptMessage } from "./threadTranscript";

function message(overrides: Partial<TranscriptMessage>): TranscriptMessage {
  return { role: "user", createdBy: "user", text: "hello", streaming: false, ...overrides };
}

describe("buildThreadTranscript", () => {
  it("serializes user and assistant messages as markdown sections under the title", () => {
    const transcript = buildThreadTranscript("Fix the login bug", [
      message({ text: "The login form crashes on submit." }),
      message({ role: "assistant", text: "Found it — the handler is missing.\n\nFixing now." }),
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

  it("omits system messages, streaming messages, and empty messages", () => {
    const transcript = buildThreadTranscript("Title", [
      message({ role: "system", text: "internal setup" }),
      message({ text: "question" }),
      message({ role: "assistant", text: "half an ans", streaming: true }),
      message({ role: "assistant", text: "   " }),
    ]);
    expect(transcript.messageCount).toBe(1);
    expect(transcript.text).not.toContain("internal setup");
    expect(transcript.text).not.toContain("half an ans");
  });

  it("omits completion notifications that woke the agent", () => {
    const transcript = buildThreadTranscript("Title", [
      message({ text: "Investigate the hang" }),
      message({
        text: "<task-notification>Subagent finished: found the root cause</task-notification>",
        notification: {
          source: { kind: "subagent" },
          outcome: "completed",
          summary: "Subagent finished",
        },
      }),
      message({
        text: "Delegated task finished: ran the tests",
        delegatedCompletion: {
          parentRunId: RunId.make("run-1"),
          generation: 1,
          taskIds: [NodeId.make("node-1")],
        },
      }),
      message({ role: "assistant", text: "The subagent found the root cause." }),
    ]);
    expect(transcript.messageCount).toBe(2);
    expect(transcript.text).not.toContain("found the root cause</task-notification>");
    expect(transcript.text).not.toContain("ran the tests");
  });

  it("attributes messages sent by another agent or an automation", () => {
    const transcript = buildThreadTranscript("Title", [
      message({ text: "Rebase onto main", createdBy: "agent" }),
      message({ text: "Run the nightly audit", scheduledTaskId: ScheduledTaskId.make("task-1") }),
      message({
        id: "scheduled-task-message:task-2:3:scheduled",
        text: "[Triggered by schedule task: Audit]\n\nCheck the queue",
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
      message({
        text: "Why did the tests fail?\n\n<terminal_context>\n- Terminal 1 line 12:\n  12 | 1 failed\n</terminal_context>",
      }),
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
      message({ text: "See attached.", attachments: [imageAttachment, fileAttachment] }),
      message({ text: "", attachments: [imageAttachment] }),
    ]);
    expect(transcript.messageCount).toBe(2);
    expect(transcript.text).toContain(
      "See attached.\n\n[Attached files: screenshot.png, notes.md]",
    );
    expect(transcript.text).toContain("## User\n\n[Attached file: screenshot.png]");
  });

  it("returns an empty transcript when nothing survives filtering", () => {
    const transcript = buildThreadTranscript("Title", [
      message({ role: "assistant", text: "", streaming: true }),
    ]);
    expect(transcript.messageCount).toBe(0);
  });
});
