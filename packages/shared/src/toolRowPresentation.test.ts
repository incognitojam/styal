import { describe, expect, it } from "vite-plus/test";
import { deriveToolRowPresentation } from "./toolRowPresentation.ts";

describe("deriveToolRowPresentation", () => {
  it("names the well-typed actions identically across providers", () => {
    // Claude sends "Command run", Codex sends "Ran command" for the same act.
    const claude = deriveToolRowPresentation({
      toolName: "Bash",
      itemType: "command_execution",
      label: "Command run",
      command: "vp test run",
    });
    const codex = deriveToolRowPresentation({
      itemType: "command_execution",
      label: "Ran command",
      command: "vp test run",
    });

    expect(claude?.heading).toBe("Ran command");
    expect(codex?.heading).toBe("Ran command");
    expect(claude?.argument).toEqual({ kind: "command", value: "vp test run" });
  });

  it("names unknown tools after themselves instead of 'Tool call'", () => {
    expect(
      deriveToolRowPresentation({
        toolName: "Read",
        itemType: "dynamic_tool_call",
        label: "Tool call",
        input: { file_path: "/tmp/notes.md" },
      }),
    ).toEqual({
      heading: "Read",
      argument: { kind: "path", value: "/tmp/notes.md" },
    });

    // A tool nobody has written a table entry for still reads correctly.
    expect(
      deriveToolRowPresentation({
        toolName: "DesignSync",
        itemType: "dynamic_tool_call",
        label: "Tool call",
      })?.heading,
    ).toBe("DesignSync");
  });

  it("overrides the adapters' substring misclassification", () => {
    // "TaskCreate" contains "create", so it arrives typed as a file change.
    expect(
      deriveToolRowPresentation({
        toolName: "TaskCreate",
        itemType: "file_change",
        label: "File change",
        input: { subject: "PR 1: Move board libs to shared/" },
      }),
    ).toEqual({
      heading: "Created task",
      argument: { kind: "text", value: "PR 1: Move board libs to shared/" },
    });
  });

  it("distinguishes memory writes from ordinary file writes", () => {
    expect(
      deriveToolRowPresentation({
        toolName: "Write",
        itemType: "file_change",
        input: { file_path: "/Users/x/.claude/projects/-p/memory/chart-hover.md" },
      }),
    ).toEqual({ heading: "Saved memory", argument: { kind: "text", value: "chart-hover" } });

    expect(
      deriveToolRowPresentation({
        toolName: "Write",
        itemType: "file_change",
        input: { file_path: "/repo/src/memoryPool.ts" },
      })?.heading,
    ).toBe("Wrote file");

    // The index every memory is listed in, not a memory.
    expect(
      deriveToolRowPresentation({
        toolName: "Edit",
        itemType: "file_change",
        input: { file_path: "/Users/x/.claude/projects/-p/memory/MEMORY.md" },
      }),
    ).toEqual({ heading: "Updated memory index" });
  });

  it("summarizes ToolSearch selections instead of echoing the query", () => {
    expect(
      deriveToolRowPresentation({
        toolName: "ToolSearch",
        itemType: "dynamic_tool_call",
        input: {
          query:
            "select:mcp__t3-code__preview_open,mcp__t3-code__preview_status,mcp__t3-code__preview_navigate",
        },
      })?.argument,
    ).toEqual({ kind: "text", value: "preview_open, preview_status +1 more" });
  });

  it("renders MCP tools as server · tool", () => {
    expect(
      deriveToolRowPresentation({
        toolName: "mcp__t3-code__preview_snapshot",
        itemType: "mcp_tool_call",
        label: "MCP tool call",
      })?.heading,
    ).toBe("t3-code · preview_snapshot");
  });

  it("counts multi-file edits", () => {
    expect(
      deriveToolRowPresentation({
        itemType: "file_change",
        label: "File change",
        changedFiles: ["a/one.ts", "a/two.ts", "a/three.ts"],
      }),
    ).toEqual({
      heading: "Edited 3 files",
      argument: { kind: "path", value: "a/one.ts", moreCount: 2 },
    });
  });

  it("derives a verb from a tool name alone for the agents panel", () => {
    expect(deriveToolRowPresentation({ toolName: "Bash" })?.heading).toBe("Ran command");
    expect(deriveToolRowPresentation({ toolName: "Edit" })?.heading).toBe("Edited file");
    expect(deriveToolRowPresentation({ toolName: "Monitor" })?.heading).toBe("Monitor");
  });

  it("keeps a title the provider chose for this specific call", () => {
    // An ACP tool that named itself outranks the verb for its item type.
    expect(
      deriveToolRowPresentation({
        itemType: "command_execution",
        label: "Run tests",
        command: "bun run test",
      }),
    ).toEqual({ heading: "Run tests", argument: { kind: "command", value: "bun run test" } });
  });

  it("falls back to the provider label, and never to a generic one", () => {
    expect(deriveToolRowPresentation({ label: "Reviewed diff started" })?.heading).toBe(
      "Reviewed diff",
    );
    expect(deriveToolRowPresentation({ label: "Tool call" })).toBeUndefined();
    expect(deriveToolRowPresentation({ label: "Command run" })).toBeUndefined();
    expect(deriveToolRowPresentation({})).toBeUndefined();
  });

  it("keeps arguments to a single line", () => {
    const argument = deriveToolRowPresentation({
      toolName: "SendMessage",
      input: { to: "a90dd06a", summary: "Address review:\n  API-failure fallback gate" },
    })?.argument;
    expect(argument?.value).toBe("→ a90dd06a · Address review: API-failure fallback gate");
  });
});
