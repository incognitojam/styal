import { EventId, ThreadId, TurnId, TurnItemId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { legacyActivityTurnItem } from "./LegacyHistoricalItems.ts";

const identity = {
  id: TurnItemId.make("import:v1:activity:thread-1:call-1"),
  threadId: ThreadId.make("thread-1"),
  ordinal: 1,
};

const completed = (payload: Record<string, unknown>) => [
  {
    id: EventId.make("activity-1"),
    tone: "tool" as const,
    kind: "tool.completed",
    summary: "Tool call",
    payload: { toolCallId: "call-1", status: "completed", ...payload },
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-01-01T00:00:00.000Z",
  },
];

describe("legacyActivityTurnItem", () => {
  // Payload shapes as v0.1.0 recorded them for each provider.
  it.each([
    {
      provider: "Claude command",
      payload: {
        itemType: "command_execution",
        title: "Command run",
        detail: "Bash: python3 calc.py",
        data: {
          toolName: "Bash",
          input: { command: "python3 calc.py", description: "Run calc" },
          result: { type: "tool_result", content: "3", is_error: false },
        },
      },
      expected: { type: "command_execution", input: "python3 calc.py", output: "3" },
    },
    {
      provider: "Claude tool",
      payload: {
        itemType: "dynamic_tool_call",
        title: "Tool call",
        data: {
          toolName: "Read",
          input: { file_path: "/synthetic/calc.py" },
          result: { type: "tool_result", content: "1\tdef add(a, b):" },
        },
      },
      expected: {
        type: "dynamic_tool",
        toolName: "Read",
        input: { file_path: "/synthetic/calc.py" },
        output: "1\tdef add(a, b):",
      },
    },
    {
      provider: "OpenCode tool",
      payload: {
        itemType: "dynamic_tool_call",
        title: "calc.py",
        data: {
          toolName: "read",
          state: { status: "completed", input: { filePath: "calc.py" }, output: "contents" },
        },
      },
      expected: {
        type: "dynamic_tool",
        toolName: "read",
        input: { filePath: "calc.py" },
        output: "contents",
      },
    },
    {
      provider: "Codex MCP tool",
      payload: {
        itemType: "mcp_tool_call",
        title: "MCP tool call",
        data: {
          item: {
            type: "mcpToolCall",
            server: "docs",
            tool: "search",
            arguments: { query: "calc" },
            result: { content: [] },
          },
        },
      },
      expected: {
        type: "dynamic_tool",
        toolName: "mcp__docs__search",
        input: { query: "calc" },
        output: { content: [] },
      },
    },
  ])("keeps what a $provider recorded", ({ payload, expected }) => {
    expect(legacyActivityTurnItem(identity, completed(payload))).toMatchObject(expected);
  });
});
