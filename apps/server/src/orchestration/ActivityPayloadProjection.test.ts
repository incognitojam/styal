import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { projectActivityPayload } from "./ActivityPayloadProjection.ts";

function activity(payload: Record<string, unknown>): OrchestrationThreadActivity {
  return {
    id: "activity-1",
    tone: "tool",
    kind: "tool.completed",
    summary: "Tool",
    payload,
    turnId: null,
    createdAt: "2026-08-01T10:00:00.000Z",
  } as unknown as OrchestrationThreadActivity;
}

function commandActivity(data: Record<string, unknown>): OrchestrationThreadActivity {
  return activity({
    itemType: "command_execution",
    status: "completed",
    title: "Ran command",
    detail: "/bin/zsh -lc 'echo ping'",
    data,
  });
}

/**
 * Wire-survival regression: the slimming pass rewrites payload.data but must
 * never strip the top-level per-agent fields the subagent fold depends on.
 * If slimming ever moves to an allowlist over the whole payload, these
 * assertions are the tripwire.
 */
describe("projectActivityPayload agent-field survival", () => {
  it("preserves tool attribution (agentId/parentToolUseId) through data slimming", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "command_execution",
        agentId: "task-123",
        parentToolUseId: "toolu_abc",
        data: {
          toolName: "Bash",
          input: { command: "ls" },
          command: "ls",
          rawOutput: { content: "x".repeat(10) },
          somethingClientNeverReads: { big: "blob" },
        },
      }),
    );
    const payload = projected.payload as Record<string, unknown>;
    expect(payload.agentId).toBe("task-123");
    expect(payload.parentToolUseId).toBe("toolu_abc");
    // Slimming itself still applies to data.
    const data = payload.data as Record<string, unknown>;
    expect(data.somethingClientNeverReads).toBeUndefined();
  });

  it("keeps a bounded Codex command output summary", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: {
          item: {
            command: "/bin/zsh -lc 'printf hello'",
            aggregatedOutput: `hello from codex\n${"x".repeat(5000)}`,
          },
        },
      }),
    );
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.item).toEqual({
      command: "/bin/zsh -lc 'printf hello'",
      aggregatedOutput: "hello from codex",
    });
    expect(JSON.stringify(projected.payload).length).toBeLessThan(500);
  });

  it("keeps bounded Claude and ACP command output summaries", () => {
    const claude = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: {
          command: "printf hello",
          rawOutput: { stdout: `hello from claude\n${"y".repeat(5000)}` },
        },
      }),
    );
    const acp = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: {
          command: "printf hello",
          content: [
            {
              type: "content",
              content: { type: "text", text: `hello from acp\n${"z".repeat(5000)}` },
            },
          ],
        },
      }),
    );

    const claudeData = (claude.payload as Record<string, unknown>).data as Record<string, unknown>;
    const acpData = (acp.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect(claudeData.rawOutput).toEqual({ content: "hello from claude" });
    expect(acpData.rawOutput).toEqual({ content: "hello from acp" });
    expect(JSON.stringify(claude.payload).length).toBeLessThan(500);
    expect(JSON.stringify(acp.payload).length).toBeLessThan(500);
  });

  it("slims Codex-shaped mcp_tool_call items to rendered fields plus a result summary", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "mcp_tool_call",
        data: {
          item: {
            type: "mcpToolCall",
            id: "item-1",
            tool: "fetch_pr",
            server: "github",
            status: "completed",
            arguments: { pr: 42 },
            durationMs: 1200,
            result: {
              content: [{ type: "text", text: `PR body line one\n${"x".repeat(5000)}` }],
              structuredContent: { huge: "y".repeat(5000) },
            },
            _meta: { internal: true },
          },
        },
      }),
    );
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    const item = data.item as Record<string, unknown>;
    expect(item.tool).toBe("fetch_pr");
    expect(item.server).toBe("github");
    expect(item.arguments).toEqual({ pr: 42 });
    expect(item._meta).toBeUndefined();
    expect(item.result).toEqual({ content: "PR body line one" });
    expect(JSON.stringify(projected.payload).length).toBeLessThan(500);
  });

  it("slims Claude-shaped mcp_tool_call data (toolName/input/result block)", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "mcp_tool_call",
        data: {
          toolName: "mcp__github__fetch_pr",
          input: { pr: 42 },
          result: {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [{ type: "text", text: `first line of output\n${"z".repeat(5000)}` }],
          },
        },
      }),
    );
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.toolName).toBe("mcp__github__fetch_pr");
    expect(data.input).toEqual({ pr: 42 });
    expect(data.result).toEqual({ content: "first line of output" });
    expect(JSON.stringify(projected.payload).length).toBeLessThan(500);
  });

  it("passes task lifecycle payloads (no data field) through untouched", () => {
    const source = activity({
      taskId: "task-9",
      title: "Audit auth",
      role: "explorer",
      model: "opus",
      effort: "high",
      workflowName: "audit-flow",
      phases: [{ index: 0, title: "Audit" }],
      typedUsage: { totalTokens: 1200 },
      runHandles: { runId: "run-1", scriptPath: "/tmp/wf.js" },
      timelineBypass: true,
    });
    const projected = projectActivityPayload(source);
    expect(projected.payload).toEqual(source.payload);
  });
});

describe("projectActivityPayload command exit codes", () => {
  it("hides historical empty terminal polls and strips stdin", () => {
    const projected = projectActivityPayload({
      ...activity({}),
      kind: "tool.updated",
      summary: "Tool updated",
      payload: {
        itemType: "command_execution",
        data: {
          itemId: "exec-1",
          processId: "1234",
          stdin: "",
          threadId: "provider-thread-1",
          turnId: "turn-1",
        },
      },
    } as OrchestrationThreadActivity);

    expect(projected.payload).toMatchObject({
      itemType: "command_execution",
      timelineBypass: true,
      data: {},
    });
    expect(JSON.stringify(projected.payload)).not.toContain("stdin");
  });

  it("projects historical Ctrl+C as a sanitized interaction", () => {
    const projected = projectActivityPayload({
      ...activity({}),
      kind: "tool.updated",
      summary: "Tool updated",
      payload: {
        itemType: "command_execution",
        data: {
          itemId: "exec-1",
          processId: "1234",
          stdin: "\u0003",
          threadId: "provider-thread-1",
          turnId: "turn-1",
        },
      },
    } as OrchestrationThreadActivity);

    expect(projected).toMatchObject({
      tone: "info",
      kind: "command.interaction",
      summary: "Sent Ctrl+C",
      payload: {
        interaction: "ctrl_c",
        commandItemId: "exec-1",
      },
    });
    expect(JSON.stringify(projected)).not.toContain("stdin");
  });

  it("projects historical text input without exposing its content", () => {
    const projected = projectActivityPayload({
      ...activity({}),
      kind: "tool.updated",
      summary: "Tool updated",
      payload: {
        itemType: "command_execution",
        data: {
          itemId: "exec-1",
          processId: "1234",
          stdin: "sensitive input",
          threadId: "provider-thread-1",
          turnId: "turn-1",
        },
      },
    } as OrchestrationThreadActivity);

    expect(projected).toMatchObject({
      tone: "info",
      kind: "command.interaction",
      summary: "Sent input to command",
      payload: {
        interaction: "input",
        commandItemId: "exec-1",
      },
    });
    expect(JSON.stringify(projected)).not.toContain("sensitive input");
  });

  it("does not hide unrelated command updates", () => {
    const projected = projectActivityPayload({
      ...activity({}),
      kind: "tool.updated",
      payload: {
        itemType: "command_execution",
        data: {
          item: {
            command: "bun test",
            status: "inProgress",
          },
        },
      },
    } as OrchestrationThreadActivity);

    expect(projected.payload).not.toHaveProperty("timelineBypass");
  });

  it("strips stdin even when a command update does not match the interaction shape", () => {
    const projected = projectActivityPayload({
      ...activity({}),
      kind: "tool.updated",
      payload: {
        itemType: "command_execution",
        data: {
          stdin: "sensitive input",
          unexpectedFutureField: true,
        },
      },
    } as OrchestrationThreadActivity);

    expect(projected.payload).not.toHaveProperty("timelineBypass");
    expect(JSON.stringify(projected.payload)).not.toContain("sensitive input");
  });

  it("retains a Codex command exit code while dropping command output", () => {
    const projected = projectActivityPayload(
      commandActivity({
        completedAtMs: 1_785_974_254_706,
        item: {
          aggregatedOutput: "ping\n",
          command: "/bin/zsh -lc 'echo ping'",
          exitCode: 0,
          status: "completed",
        },
      }),
    );

    expect(projected.payload).toMatchObject({
      data: {
        item: {
          command: "/bin/zsh -lc 'echo ping'",
          exitCode: 0,
        },
      },
    });
    expect(JSON.stringify(projected.payload)).not.toContain("aggregatedOutput");
  });

  it("retains an ACP command exit code while dropping command output", () => {
    const projected = projectActivityPayload(
      commandActivity({
        kind: "execute",
        command: "bun run check",
        rawOutput: {
          exitCode: 17,
          stdout: "check failed\nmore detail",
          stderr: "",
        },
      }),
    );

    expect(projected.payload).toMatchObject({
      data: {
        kind: "execute",
        command: "bun run check",
        rawOutput: {
          exitCode: 17,
        },
      },
    });
  });

  it("retains an exit code when ACP command output is empty", () => {
    const projected = projectActivityPayload(
      commandActivity({
        kind: "execute",
        rawOutput: {
          exitCode: 0,
          stdout: "",
          stderr: "",
        },
      }),
    );

    expect(projected.payload).toMatchObject({
      data: {
        rawOutput: { exitCode: 0 },
      },
    });
  });
});

describe("projectActivityPayload file changes", () => {
  it("keeps a compact path and line stat while dropping Edit source strings", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "file_change",
        title: "File change",
        detail: 'Edit: {"file_path":"/workspace/main.swift"}',
        data: {
          toolName: "Edit",
          input: {
            file_path: "/workspace/main.swift",
            old_string: "one\ntwo\nthree",
            new_string: "one\nupdated\nthree\nfour",
          },
        },
      }),
    );

    expect(projected.payload).toMatchObject({
      data: {
        files: [{ path: "/workspace/main.swift" }],
        fileChangeStat: { additions: 2, deletions: 1 },
      },
    });
    expect(JSON.stringify(projected.payload)).not.toContain("old_string");
    expect(JSON.stringify(projected.payload)).not.toContain("new_string");
  });

  it("derives line stats from Codex file-change diffs", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "file_change",
        title: "File change",
        data: {
          item: {
            type: "fileChange",
            changes: [
              {
                path: "src/app.ts",
                kind: { type: "update" },
                diff: "@@ -1,3 +1,4 @@\n one\n-two\n+updated\n three\n+four",
              },
              {
                path: "README.md",
                kind: { type: "add" },
                diff: "# New\n\nDetails\n",
              },
              {
                path: "old.txt",
                kind: { type: "delete" },
                diff: "old\nlines\n",
              },
            ],
          },
        },
      }),
    );

    expect(projected.payload).toMatchObject({
      data: {
        files: [{ path: "src/app.ts" }, { path: "README.md" }, { path: "old.txt" }],
        fileChangeStat: { additions: 5, deletions: 3 },
      },
    });
    expect(JSON.stringify(projected.payload)).not.toContain("@@ -1,3");
  });
});
