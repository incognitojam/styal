import { describe, expect, it } from "vite-plus/test";
import { deriveToolRowPresentation, isPreviewToolName } from "./toolRowPresentation.ts";

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

  it("treats OpenCode's raw tool title as identity, not presentation", () => {
    expect(
      deriveToolRowPresentation({
        toolName: "edit",
        itemType: "file_change",
        label: "edit",
        input: { file_path: "/repo/src/app.ts" },
      }),
    ).toEqual({
      heading: "Edited file",
      argument: { kind: "path", value: "/repo/src/app.ts" },
    });
  });

  it("normalizes OpenCode read and grep names", () => {
    expect(
      deriveToolRowPresentation({
        toolName: "read",
        itemType: "dynamic_tool_call",
        label: "read",
        input: { file_path: "/repo/src/app.ts" },
      }),
    ).toEqual({ heading: "Read", argument: { kind: "path", value: "/repo/src/app.ts" } });
    expect(
      deriveToolRowPresentation({
        toolName: "grep",
        itemType: "dynamic_tool_call",
        label: "grep",
        input: { pattern: "worker" },
      }),
    ).toEqual({ heading: "Grep", argument: { kind: "text", value: "worker" } });
  });

  it("describes failed edits as failures", () => {
    expect(
      deriveToolRowPresentation({
        toolName: "edit",
        itemType: "file_change",
        label: "edit",
        input: { file_path: "/repo/src/app.ts" },
        failed: true,
      }),
    ).toEqual({
      heading: "Edit failed",
      argument: { kind: "path", value: "/repo/src/app.ts" },
    });
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
        toolName: "mcp__linear__create_issue",
        itemType: "mcp_tool_call",
        label: "MCP tool call",
      })?.heading,
    ).toBe("linear · create_issue");
  });

  describe("T3 preview tools", () => {
    const PREVIEW_HEADINGS = [
      ["preview_status", "Checked preview status"],
      ["preview_open", "Opened preview"],
      ["preview_navigate", "Navigated preview"],
      ["preview_resize", "Resized preview"],
      ["preview_set_appearance", "Set preview appearance"],
      ["preview_snapshot", "Inspected page"],
      ["preview_click", "Clicked"],
      ["preview_type", "Typed"],
      ["preview_press", "Pressed"],
      ["preview_scroll", "Scrolled"],
      ["preview_evaluate", "Ran JS in preview"],
      ["preview_wait_for", "Waited for condition"],
      ["preview_recording_start", "Started recording preview"],
      ["preview_recording_stop", "Stopped recording preview"],
    ] as const;

    const preview = (toolName: string, input: Record<string, unknown> = {}, failed = false) =>
      deriveToolRowPresentation({
        toolName: `mcp__t3-code__${toolName}`,
        itemType: "mcp_tool_call",
        label: "MCP tool call",
        input,
        failed,
      });

    it("names the action instead of server · tool", () => {
      expect(preview("preview_open", { url: "http://localhost:5173" })).toEqual({
        heading: "Opened preview",
        argument: { kind: "text", value: "http://localhost:5173" },
      });
      expect(preview("preview_navigate", { url: "http://localhost:5173" })?.heading).toBe(
        "Navigated preview",
      );
      expect(preview("preview_snapshot")?.heading).toBe("Inspected page");
      expect(preview("preview_status")?.heading).toBe("Checked preview status");
    });

    it("renders dev-server navigation targets", () => {
      expect(
        preview("preview_navigate", { target: { kind: "environment-port", port: 5173 } })?.argument,
      ).toEqual({ kind: "text", value: "dev server :5173" });
      expect(
        preview("preview_navigate", {
          target: { kind: "environment-port", port: 5173, path: "/settings?tab=account" },
        })?.argument,
      ).toEqual({ kind: "text", value: "dev server :5173/settings?tab=account" });
      expect(
        preview("preview_navigate", {
          target: { kind: "url", url: "https://t3.chat/settings" },
        })?.argument,
      ).toEqual({ kind: "text", value: "https://t3.chat/settings" });
    });

    it("shows the interaction target, not session noise", () => {
      expect(
        preview("preview_click", {
          tabId: "preview-thread-1",
          locator: "role=button[name='Send']",
          timeoutMs: 15000,
        }),
      ).toEqual({
        heading: "Clicked",
        argument: { kind: "text", value: "role=button[name='Send']" },
      });
      expect(preview("preview_click", { x: 10, y: 20 })?.argument).toEqual({
        kind: "text",
        value: "10, 20",
      });
      expect(preview("preview_type", { text: "Hello there" })?.argument).toEqual({
        kind: "text",
        value: "“Hello there”",
      });
      expect(
        preview("preview_press", { key: "Enter", modifiers: ["Meta", "Shift"] })?.argument,
      ).toEqual({ kind: "text", value: "Meta+Shift+Enter" });
      expect(preview("preview_scroll", { deltaY: 300, deltaX: -50 })?.argument).toEqual({
        kind: "text",
        value: "down 300px left 50px",
      });
      expect(preview("preview_scroll", { deltaY: -80 })?.argument).toEqual({
        kind: "text",
        value: "up 80px",
      });
      expect(preview("preview_wait_for", { text: "Ready" })?.argument).toEqual({
        kind: "text",
        value: "Ready",
      });
      expect(preview("preview_evaluate", { expression: "document.title" })?.argument).toEqual({
        kind: "text",
        value: "document.title",
      });
    });

    it("composes resize and appearance arguments", () => {
      expect(
        preview("preview_resize", { mode: "freeform", width: 1024, height: 768 })?.argument,
      ).toEqual({ kind: "text", value: "1024×768" });
      expect(
        preview("preview_resize", {
          mode: "preset",
          preset: "iphone-12-pro",
          orientation: "landscape",
        })?.argument,
      ).toEqual({ kind: "text", value: "iphone-12-pro landscape" });
      expect(preview("preview_set_appearance", { colorScheme: "dark" })?.argument).toEqual({
        kind: "text",
        value: "dark",
      });
    });

    it("omits the argument when the call had none worth showing", () => {
      expect(preview("preview_snapshot", { tabId: "preview-thread-1" })).toEqual({
        heading: "Inspected page",
      });
      expect(preview("preview_open", { open: true, show: true })).toEqual({
        heading: "Opened preview",
      });
      expect(preview("preview_scroll", { selector: "main" })).toEqual({ heading: "Scrolled" });
    });

    it("gives every tool in the family a curated heading", () => {
      // Membership is derived from the spec table's keys, so a tool that
      // reaches the row without a heading would fall back to `t3-code · …`.
      for (const [tool, heading] of PREVIEW_HEADINGS) {
        expect(isPreviewToolName(`mcp__t3-code__${tool}`)).toBe(true);
        expect(preview(tool)?.heading).toBe(heading);
      }
    });

    it("describes a fill-mode resize as fitting the panel", () => {
      expect(preview("preview_resize", { mode: "fill" })?.argument).toEqual({
        kind: "text",
        value: "fit preview panel",
      });
    });

    it("matches bare preview names as well as the MCP-qualified form", () => {
      expect(
        deriveToolRowPresentation({
          toolName: "preview_navigate",
          itemType: "dynamic_tool_call",
          label: "preview_navigate",
          input: { url: "https://t3.chat" },
        })?.heading,
      ).toBe("Navigated preview");
    });

    it("keeps every heading readable without its argument", () => {
      // The timeline row renders `heading - argument`, and the agents panel
      // has only a tool name, so a heading ending in a preposition breaks both.
      for (const [, heading] of PREVIEW_HEADINGS) {
        expect(heading).not.toMatch(/\b(?:to|for|with|in|at|from|into)$/u);
      }
    });

    it("describes failures as failures", () => {
      expect(preview("preview_click", { locator: "role=button" }, true)).toEqual({
        heading: "Failed to click",
        argument: { kind: "text", value: "role=button" },
      });
      expect(preview("preview_navigate", { url: "https://t3.chat" }, true)?.heading).toBe(
        "Failed to navigate",
      );
    });
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
