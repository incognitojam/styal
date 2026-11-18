import { describe, expect, it } from "vite-plus/test";

import { RunId, ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  continuedResponseWorkStartedAt,
  omitUserAttachmentImages,
  assistantLinkedUrlKeysByRunId,
  foldViewedSources,
  omitViewedSources,
  workEntriesViewedSources,
  omitRetriedFindingsReports,
  resolveWorkEntryToolPresentation,
  resolveWorkEntryToolRowPresentation,
  summarizeToolGroup,
  toolGroupAction,
  toolGroupSummaryKind,
  memoryRowLabel,
  workEntryReadsMemoryFile,
  toolItemForDisplay,
  type WorkLogPresentationEntry,
  type WorkLogToolLifecycleStatus,
  workEntryIndicatesToolFailure,
  workEntryDisplayIndicatesToolFailure,
  workEntryToolRefusalSummary,
} from "./presentation.ts";

function commandItem(
  fields: Partial<Extract<OrchestrationV2TurnItem, { type: "command_execution" }>> = {},
): OrchestrationV2TurnItem {
  return {
    id: TurnItemId.make("command"),
    threadId: ThreadId.make("thread"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-09-08T00:00:00.000Z"),
    type: "command_execution",
    input: 'rg "command not found"',
    ...fields,
  };
}

describe("workEntryIndicatesToolFailure", () => {
  const base = {
    id: "w1",
    createdAt: "2026-01-01T00:00:00.000Z",
    label: "Read",
  };

  it.each([
    [{ exitCode: 2 }, true],
    [{ output: "sh: missing-command: command not found" }, true],
    [{ output: `${"x".repeat(32_768)} command not found` }, false],
  ] as const)(
    "preserves command failure state after removing displayed output: %j",
    (fields, failed) => {
      const structuredPayload = commandItem(fields);
      const entry: WorkLogPresentationEntry = {
        ...base,
        tone: "tool",
        itemType: "command_execution",
        toolLifecycleStatus: "completed",
        structuredPayload,
      };
      expect(workEntryDisplayIndicatesToolFailure(entry)).toBe(failed);
      expect(JSON.stringify(toolItemForDisplay(structuredPayload))).not.toContain('"output":');
    },
  );

  it.each([
    "logs/app.log:12: Error: ENOENT: no such file or directory",
    "fixtures/ci.txt:3: Process exited with exit code 2",
  ])("trusts a zero exit code over failure text in the output and command: %s", (output) => {
    const entry: WorkLogPresentationEntry = {
      ...base,
      tone: "tool",
      itemType: "command_execution",
      toolLifecycleStatus: "completed",
      command: 'rg -n "ENOENT|exit code" logs fixtures',
      structuredPayload: commandItem({ output, exitCode: 0, outputIndicatesFailure: true }),
    };
    expect(workEntryIndicatesToolFailure(entry)).toBe(false);
    expect(workEntryDisplayIndicatesToolFailure(entry)).toBe(false);
  });

  it.each([0, undefined])(
    "preserves blocked and stopped commands with exit code %s",
    (exitCode) => {
      const blocked: WorkLogPresentationEntry = {
        ...base,
        tone: "tool",
        itemType: "command_execution",
        toolLifecycleStatus: "failed",
        structuredPayload: commandItem({
          exitCode,
          status: "failed",
          toolDenial: { source: "auto_mode", reason: "External System Writes" },
        }),
      };
      expect(workEntryDisplayIndicatesToolFailure(blocked)).toBe(true);
      expect(workEntryToolRefusalSummary(blocked)).toBe(
        "Blocked by Auto mode: External System Writes",
      );
      const stopped: WorkLogPresentationEntry = {
        ...base,
        tone: "tool",
        itemType: "command_execution",
        toolLifecycleStatus: "stopped",
        structuredPayload: commandItem({ exitCode, status: "cancelled" }),
      };
      expect(resolveWorkEntryToolRowPresentation(stopped)?.heading).toBe("Command stopped");
      expect(workEntryDisplayIndicatesToolFailure(stopped)).toBe(false);
    },
  );

  it("ignores failure phrases in reasoning text", () => {
    const entry: WorkLogPresentationEntry = {
      ...base,
      label: "Thinking",
      tone: "thinking",
      itemType: "reasoning",
      toolLifecycleStatus: "completed",
      detail: "That exit code 2 is just from listing the deleted directory, which is expected.",
    };
    expect(workEntryIndicatesToolFailure(entry)).toBe(false);
    expect(workEntryDisplayIndicatesToolFailure(entry)).toBe(false);
  });

  it("is true when a command has a nonzero exit code", () => {
    expect(
      workEntryIndicatesToolFailure({
        ...base,
        tone: "tool",
        itemType: "command_execution",
        toolLifecycleStatus: "completed",
        exitCode: 17,
      }),
    ).toBe(true);
  });

  it("detects OpenCode edit mismatch output even without explicit failed status", () => {
    expect(
      workEntryIndicatesToolFailure({
        ...base,
        tone: "tool",
        itemType: "file_change",
        toolLifecycleStatus: "completed",
        detail:
          "Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings.",
      }),
    ).toBe(true);
  });

  it("does not treat error text in a command as rendered failure", () => {
    const entry = {
      ...base,
      label: "Ran command",
      tone: "tool",
      toolLifecycleStatus: "completed",
      command: 'rg "file not found"',
      detail: "Found 3 matches",
    } satisfies WorkLogPresentationEntry;

    expect(workEntryDisplayIndicatesToolFailure(entry)).toBe(false);

    expect(workEntryIndicatesToolFailure(entry)).toBe(true);
    expect(workEntryDisplayIndicatesToolFailure({ ...entry, detail: "File not found" })).toBe(true);
  });
});

describe("workEntryToolRefusalSummary", () => {
  it.each([
    [
      { source: "auto_mode", reason: "External System Writes" },
      "Blocked by Auto mode: External System Writes",
    ],
    [
      { source: "auto_mode", reason: "[Unauthorized Persistence]" },
      "Blocked by Auto mode: Unauthorized Persistence",
    ],
    [{ source: "auto_mode" }, "Blocked by Auto mode"],
    [{ source: "settings", reason: " " }, "Blocked by permission settings"],
    [undefined, null],
  ] as const)("summarizes %o", (toolDenial, expected) => {
    const structuredPayload = commandItem({
      status: "failed",
      toolNonExecutionKind: "permission-rule",
      ...(toolDenial === undefined ? {} : { toolDenial }),
    });
    expect(workEntryToolRefusalSummary({ structuredPayload })).toBe(expected);
  });
});

describe("summarizeToolGroup", () => {
  const entry = (
    id: string,
    overrides: Partial<WorkLogPresentationEntry>,
  ): WorkLogPresentationEntry => ({
    id,
    createdAt: "2026-09-01T00:00:00Z",
    label: "Tool call",
    tone: "tool",
    ...overrides,
  });

  it("counts projected memory file changes as memory updates", () => {
    const fileChange = (id: string, path: string) =>
      entry(id, { label: `Changed ${path}`, itemType: "file_change", changedFiles: [path] });
    const memory = (name: string) =>
      fileChange(name, `/synthetic/.claude/projects/-demo/memory/${name}.md`);

    expect(summarizeToolGroup([memory("first"), memory("first")]).summary).toBe("Updated 1 memory");
    expect(toolGroupSummaryKind([memory("first")])).toBe("memory");
    expect(
      summarizeToolGroup([
        memory("first"),
        memory("MEMORY"),
        fileChange("repo", "/synthetic/docs/memory/design.md"),
      ]).summary,
    ).toBe("Updated 1 memory and changed 1 file");
    expect(memoryRowLabel(memory("first"))).toBe("Updated memory - first");
    expect(memoryRowLabel(memory("MEMORY"))).toBe("Updated memory index");
    // A write the user interrupted never finished, so it must not claim an update.
    expect(memoryRowLabel({ ...memory("first"), toolLifecycleStatus: "stopped" })).toBe(
      "Edit stopped - first",
    );
  });

  it("does not count failed or declined edits as changed files", () => {
    const fileChange = (id: string, path: string, status?: WorkLogToolLifecycleStatus) =>
      entry(id, {
        label: `Changed ${path}`,
        itemType: "file_change",
        changedFiles: [path],
        ...(status ? { toolLifecycleStatus: status } : {}),
      });
    expect(
      summarizeToolGroup([fileChange("blocked", "/synthetic/.bashrc", "failed")]).summary,
    ).toBe("Tried to change 1 file");
    expect(
      summarizeToolGroup([
        fileChange("declined", "/synthetic/a.ts", "declined"),
        fileChange("failed", "/synthetic/b.ts", "failed"),
      ]).summary,
    ).toBe("Tried to change 2 files");
    expect(
      summarizeToolGroup([
        fileChange("applied", "/synthetic/a.ts", "completed"),
        fileChange("failed", "/synthetic/b.ts", "failed"),
      ]).summary,
    ).toBe("Changed 1 file");
  });

  it("names memory reads without counting them as memory updates", () => {
    const read = (id: string, path: string) =>
      entry(id, {
        label: `Read ${path}`,
        itemType: "dynamic_tool",
        toolName: "Read",
        toolInput: { file_path: path },
      });
    const memory = read("memory", "/synthetic/.claude/projects/-demo/memory/first.md");
    const index = read("index", "/synthetic/.claude/projects/-demo/memory/MEMORY.md");
    const repo = read("repo", "/synthetic/docs/memory/design.md");

    expect(workEntryReadsMemoryFile(memory)).toBe(true);
    expect(workEntryReadsMemoryFile(repo)).toBe(false);
    expect(memoryRowLabel(memory)).toBe("Read memory - first");
    expect(memoryRowLabel(index)).toBe("Read memory index");
    // A read is not a memory update.
    expect(toolGroupAction(memory)).not.toBe("memory");
  });
});

describe("resolveWorkEntryToolRowPresentation", () => {
  const base = { id: "row", createdAt: "2026-01-01T00:00:00Z", tone: "tool" as const };

  it("retains preview arguments while using the shared lifecycle heading", () => {
    expect(
      resolveWorkEntryToolRowPresentation({
        ...base,
        label: "MCP tool call",
        toolName: "mcp__styal__preview_navigate",
        toolInput: { url: "https://example.com/demo", tabId: "synthetic-tab" },
        toolLifecycleStatus: "inProgress",
      }),
    ).toEqual({
      heading: "Navigating preview",
      argument: { kind: "text", value: "https://example.com/demo" },
    });
  });

  it("keeps ACP's unnamed page fetches and workspace searches distinct", () => {
    expect(
      resolveWorkEntryToolRowPresentation({
        ...base,
        itemType: "web_search",
        label: "Searched files",
        toolInput: { url: "https://example.com/docs" },
      }),
    ).toEqual({
      heading: "Fetched page",
      argument: { kind: "text", value: "https://example.com/docs" },
    });
    expect(
      resolveWorkEntryToolRowPresentation({
        ...base,
        itemType: "web_search",
        label: "Searched files",
        detail: "example",
        toolInput: { directory_path: "/synthetic", query: "example" },
      }),
    ).toEqual({ heading: "Searched code", argument: { kind: "text", value: "example" } });
  });

  it("respects another server's identity when its tool shares a product name", () => {
    expect(
      resolveWorkEntryToolRowPresentation({
        ...base,
        label: "preview_click",
        toolData: { server: "playwright", tool: "preview_click" },
      })?.heading,
    ).toBe("playwright · preview_click");
  });
});

describe("resolveWorkEntryToolPresentation", () => {
  it("shows returned MCP errors as failures even in the live activity row", () => {
    const entry: WorkLogPresentationEntry = {
      id: "clone",
      createdAt: "2026-09-19T00:00:00.000Z",
      tone: "tool",
      label: "T3-code.t3_project_clone",
      toolLifecycleStatus: "inProgress",
      itemType: "dynamic_tool",
      toolData: { output: { isError: true } },
    };
    expect(resolveWorkEntryToolPresentation(entry)?.displayName).toBe(
      "Failed to clone a repository",
    );
    expect(workEntryDisplayIndicatesToolFailure(entry)).toBe(true);
    const childFailure = {
      ...entry,
      label: "T3-code.task_status",
      toolLifecycleStatus: "completed" as const,
      toolData: { output: { taskId: "child", status: "failed", summary: "command not found" } },
    };
    expect(workEntryDisplayIndicatesToolFailure(childFailure)).toBe(false);
  });
  it.each([
    "mcp__t3-code__preview_click",
    "mcp__t3_code__preview_click",
    "mcp__t3code__preview_click",
    "T3-code.preview_click",
    "t3-code · preview_click completed",
    "t3_code/preview_click",
    "preview_click",
  ])("recognizes browser tool names across providers: %s", (label) => {
    expect(resolveWorkEntryToolPresentation({ label })).toEqual({
      displayName: "Clicking",
      icon: "browser",
    });
  });

  it("uses structured MCP identity when the provider supplies a custom title", () => {
    expect(
      resolveWorkEntryToolPresentation({
        label: "Tool call complete",
        toolTitle: "Inspect the current page",
        toolData: { server: "t3-code", tool: "preview_snapshot", result: { title: "Example" } },
      }),
    ).toEqual({ displayName: "Inspecting page", icon: "browser" });
  });

  it.each([
    ["inProgress", "Clicking"],
    ["completed", "Clicked"],
    ["failed", "Failed to click"],
    ["declined", "Declined to click"],
    ["stopped", "Stopped clicking"],
    ["unknown", "Clicking"],
  ] as const)("describes the tool's own %s state", (toolLifecycleStatus, displayName) => {
    expect(
      resolveWorkEntryToolPresentation({
        label: "T3-code.preview_click",
        toolLifecycleStatus: toolLifecycleStatus as WorkLogToolLifecycleStatus,
      }),
    ).toEqual({ displayName, icon: "browser" });
  });

  it("uses the summary's state only when the provider omitted a lifecycle status", () => {
    const entry = { label: "T3-code.preview_click" };
    expect(resolveWorkEntryToolPresentation(entry, "inProgress")?.displayName).toBe("Clicking");
    expect(resolveWorkEntryToolPresentation(entry, "completed")?.displayName).toBe("Clicked");
    expect(
      resolveWorkEntryToolPresentation({ ...entry, toolLifecycleStatus: "completed" }, "inProgress")
        ?.displayName,
    ).toBe("Clicked");
    expect(
      resolveWorkEntryToolPresentation({ ...entry, toolLifecycleStatus: "failed" }, "completed")
        ?.displayName,
    ).toBe("Failed to click");
  });

  it.each([
    ["preview_type", "Typing", "Typed"],
    ["preview_set_appearance", "Setting preview appearance", "Set preview appearance"],
    ["preview_snapshot", "Inspecting page", "Inspected page"],
    ["preview_recording_stop", "Stopping recording preview", "Stopped recording preview"],
    ["t3_thread_read", "Reading a thread", "Read a thread"],
    ["t3_thread_send", "Sending to a thread", "Sent to a thread"],
    [
      "t3_worktree_handoff",
      "Handing off thread to a git worktree",
      "Handed off thread to a git worktree",
    ],
  ])("preserves verb forms and the rest of %s's label", (tool, running, completed) => {
    const entry = { label: `t3-code.${tool}` };
    expect(
      resolveWorkEntryToolPresentation({ ...entry, toolLifecycleStatus: "inProgress" })
        ?.displayName,
    ).toBe(running);
    expect(
      resolveWorkEntryToolPresentation({ ...entry, toolLifecycleStatus: "completed" })?.displayName,
    ).toBe(completed);
  });

  it.each([
    ["https://github.com/acme/web/pull/7", "PR #7"],
    ["https://gitlab.com/acme/web/-/merge_requests/7", "MR #7"],
  ])("names a linked change request with its host's term (%s)", (url, target) => {
    expect(
      resolveWorkEntryToolPresentation({
        label: "T3-code.link_pull_request",
        toolLifecycleStatus: "completed",
        toolData: { arguments: { url } },
      })?.displayName,
    ).toMatch(new RegExp(` ${target}$`));
  });

  it("does not brand unknown tools or another server's matching tool name", () => {
    for (const label of [
      "mcp__github__preview_click",
      "t3-code.unknown_tool",
      "t3-code.toString",
      "Search files",
    ]) {
      expect(resolveWorkEntryToolPresentation({ label })).toBeNull();
    }
    expect(
      resolveWorkEntryToolPresentation({
        label: "preview_click",
        toolData: { server: "another-server", tool: "preview_click" },
      }),
    ).toBeNull();
  });
});

describe("browser group summaries", () => {
  it("counts ACP workspace searches as code searches and fetches as web lookups", () => {
    const acpSearch = {
      id: "acp-search",
      createdAt: "2026-09-01T00:00:00Z",
      label: "Searched files",
      tone: "tool" as const,
      itemType: "web_search" as const,
    };
    expect(
      summarizeToolGroup([
        { ...acpSearch, toolInput: { directory_path: "/repo", query: "posthog" } },
        { ...acpSearch, toolInput: { url: "https://example.com/docs" } },
        { ...acpSearch, toolInput: { query: "release notes" } },
      ]).summary,
    ).toBe("Searched code 1 time and searched the web 2 times");
  });
});

describe("omitRetriedFindingsReports", () => {
  const report = (id: string, turnId: string, status: "failed" | "completed") => ({
    id,
    createdAt: "2026-09-01T00:00:00Z",
    label: "ReportFindings",
    tone: "tool" as const,
    toolName: "ReportFindings",
    toolInput: { findings: [{ file: "src/a.ts", summary: "Bug" }] },
    turnId,
    toolLifecycleStatus: status,
  });

  it("drops a rejected report only when the same turn later has an accepted one", () => {
    const entries = [
      report("rejected-then-retried", "turn-1", "failed"),
      report("accepted", "turn-1", "completed"),
      report("rejected-alone", "turn-2", "failed"),
      report("accepted-before", "turn-3", "completed"),
      report("rejected-after", "turn-3", "failed"),
    ];
    expect(omitRetriedFindingsReports(entries).map((entry) => entry.id)).toEqual([
      "accepted",
      "rejected-alone",
      "accepted-before",
      "rejected-after",
    ]);
  });
});

describe("V2 continued response working clock", () => {
  const at = (minute: number) =>
    DateTime.makeUnsafe(`2026-10-11T10:${String(minute).padStart(2, "0")}:00.000Z`);
  const iso = (minute: number) => DateTime.formatIso(at(minute));
  const first = RunId.make("first");
  const second = RunId.make("second");
  const third = RunId.make("third");
  const run = (id: RunId, start: number, parent?: RunId) => ({
    id,
    requestedAt: at(start),
    startedAt: at(start),
    completedAt: null,
    status: "running" as const,
    ...(parent === undefined ? {} : { restartContinuationOfRunId: parent }),
  });
  const item = (
    runId: RunId,
    end: number,
    type: "assistant_message" | "command_execution" = "assistant_message",
  ) => ({
    runId,
    type,
    updatedAt: at(end),
    completedAt: at(end),
  });
  const projection = {
    runs: [
      { ...run(first, 0), status: "cancelled" as const, completedAt: at(20) },
      { ...run(second, 20, first), status: "cancelled" as const, completedAt: at(40) },
      run(third, 40, second),
    ],
    turnItems: [item(first, 10), item(second, 30)],
  };

  it("retains work across two restarts while excluding synthetic cancellation times and outages", () => {
    const effective = continuedResponseWorkStartedAt({
      startedAt: iso(40),
      runId: third,
      projection: structuredClone(projection),
    });
    expect(effective).toBe(iso(20));
    expect(Date.parse(iso(45)) - Date.parse(effective!)).toBe(25 * 60_000);
  });

  it("times a background wake separately from the work it follows", () => {
    const wake = RunId.make("wake");
    const continued = {
      ...projection,
      runs: [
        projection.runs[0]!,
        { ...projection.runs[1]!, workStartedAt: at(20) },
        { ...projection.runs[2]!, workStartedAt: at(20) },
        { ...run(wake, 50), workStartedAt: at(20) },
      ],
    };
    expect(
      continuedResponseWorkStartedAt({ startedAt: iso(20), runId: third, projection: continued }),
    ).toBe(iso(20));
    expect(
      continuedResponseWorkStartedAt({ startedAt: iso(20), runId: wake, projection: continued }),
    ).toBe(iso(50));
  });

  it("excludes previous responses and monitor waits when a wake is restarted", () => {
    const wake = RunId.make("wake");
    const recovery = RunId.make("recovery");
    const effective = continuedResponseWorkStartedAt({
      startedAt: iso(30),
      runId: recovery,
      projection: {
        runs: [
          { ...run(first, 0), status: "completed", completedAt: at(9) },
          { ...run(wake, 20), status: "cancelled", completedAt: at(50), workStartedAt: at(0) },
          { ...run(recovery, 50, wake), workStartedAt: at(30) },
        ],
        turnItems: [item(first, 9), item(wake, 25)],
      },
    });
    expect(effective).toBe(iso(45));
    expect(Date.parse(iso(55)) - Date.parse(effective!)).toBe(10 * 60_000);
  });

  it.each(["completed", "waiting"] as const)(
    "starts a separate response when recovery follows a %s run",
    (status) => {
      expect(
        continuedResponseWorkStartedAt({
          startedAt: iso(20),
          runId: second,
          projection: {
            runs: [
              { ...run(first, 0), status, completedAt: at(10) },
              { ...run(second, 20, first), workStartedAt: at(20) },
            ],
            turnItems: [item(first, 10)],
          },
        }),
      ).toBe(iso(20));
    },
  );

  it("starts a new wake clock while the provider is preparing", () => {
    expect(
      continuedResponseWorkStartedAt({
        startedAt: iso(0),
        runId: second,
        projection: {
          runs: [{ ...run(second, 20), startedAt: null, workStartedAt: at(0) }],
          turnItems: [],
        },
      }),
    ).toBe(iso(20));
  });

  it("uses canonical messages when the earlier response has no tool items", () => {
    expect(
      continuedResponseWorkStartedAt({
        startedAt: iso(40),
        runId: third,
        projection: {
          ...projection,
          turnItems: [],
          messages: [
            { runId: first, role: "assistant" as const, updatedAt: at(10) },
            { runId: second, role: "assistant" as const, updatedAt: at(30) },
          ],
        },
      }),
    ).toBe(iso(20));
  });

  it("uses the latest recorded tool end when earlier-started work finishes last", () => {
    const effective = continuedResponseWorkStartedAt({
      startedAt: iso(40),
      runId: third,
      projection: {
        ...projection,
        turnItems: [...projection.turnItems, item(first, 15, "command_execution")],
      },
    });
    expect(Date.parse(iso(45)) - Date.parse(effective!)).toBe(30 * 60_000);
  });

  it("excludes unrelated background work from the response", () => {
    const background = RunId.make("background");
    expect(
      continuedResponseWorkStartedAt({
        startedAt: iso(40),
        runId: third,
        projection: {
          ...projection,
          runs: [...projection.runs, run(background, 15)],
          turnItems: [...projection.turnItems, item(background, 39)],
        },
      }),
    ).toBe(iso(20));
    expect(
      continuedResponseWorkStartedAt({
        startedAt: iso(15),
        runId: background,
        projection: {
          ...projection,
          runs: [...projection.runs, run(background, 15)],
        },
      }),
    ).toBe(iso(15));
  });

  it("starts fresh for new user input and does not rewind a local send clock", () => {
    const next = RunId.make("next-user");
    expect(
      continuedResponseWorkStartedAt({
        startedAt: iso(50),
        runId: next,
        projection: {
          ...projection,
          runs: [...projection.runs, run(next, 50)],
        },
      }),
    ).toBe(iso(50));
    expect(continuedResponseWorkStartedAt({ startedAt: iso(45), runId: third, projection })).toBe(
      iso(45),
    );
  });

  it("stops on settlement and keeps a clock unchanged when parent history is missing", () => {
    expect(
      continuedResponseWorkStartedAt({ startedAt: null, runId: third, projection }),
    ).toBeNull();
    expect(
      continuedResponseWorkStartedAt({
        startedAt: iso(40),
        runId: third,
        projection: {
          ...projection,
          runs: projection.runs.slice(1),
        },
      }),
    ).toBe(iso(40));
  });
});

describe("omitUserAttachmentImages", () => {
  it.each([
    [["/data/attachments/own.png"], []],
    [["/workspace/reference.png"], ["/workspace/reference.png"]],
    [["/data/attachments/other.png"], ["/data/attachments/other.png"]],
    [["/data/attachments/own.png", "/data/attachments/own.png"], []],
    [["/workspace/own.png"], ["/workspace/own.png"]],
    [["C:\\data\\attachments\\own.png"], []],
    [["/data/not-attachments/own.png"], ["/data/not-attachments/own.png"]],
    [["/data/attachments/nested/own.png"], ["/data/attachments/nested/own.png"]],
  ])("filters only this thread's attachment files: %j", (paths, expected) => {
    expect(omitUserAttachmentImages(paths, new Set(["own"]))).toEqual(expected);
  });
});

describe("viewed sources", () => {
  const entry = (
    id: string,
    item:
      | { readonly viewedDocument: { readonly path: string; readonly pages?: string } }
      | { readonly fetchedUrl: string }
      | {
          readonly patterns: ReadonlyArray<string>;
          readonly results?: ReadonlyArray<{ readonly url?: string; readonly title?: string }>;
        }
      | { readonly toolName: string },
    status: OrchestrationV2TurnItem["status"] = "completed",
  ): WorkLogPresentationEntry => {
    const shared = {
      id: TurnItemId.make(id),
      threadId: ThreadId.make("thread"),
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status,
      title: null,
      startedAt: null,
      completedAt: null,
      updatedAt: DateTime.makeUnsafe("2026-09-08T00:00:00.000Z"),
    };
    return {
      id,
      createdAt: "2026-01-01T00:00:00.000Z",
      label: id,
      tone: "tool",
      structuredPayload:
        "fetchedUrl" in item
          ? { ...shared, type: "web_search", fetchedUrl: item.fetchedUrl }
          : "patterns" in item
            ? {
                ...shared,
                type: "web_search",
                patterns: [...item.patterns],
                ...(item.results ? { results: [...item.results] } : {}),
              }
            : {
                ...shared,
                type: "dynamic_tool",
                toolName: "toolName" in item ? item.toolName : "Read",
                input: {},
                ...("viewedDocument" in item ? { viewedDocument: item.viewedDocument } : {}),
              },
    };
  };

  it("lists documents, then pages, then searches, each once in reading order", () => {
    const sources = workEntriesViewedSources([
      entry("search-menus", {
        patterns: ["menu  guidelines"],
        results: [
          { url: "https://docs.example.com/menus", title: "Navigation menus" },
          { url: "not a url" },
        ],
      }),
      entry("fetch-menus", { fetchedUrl: "https://docs.example.com/menus" }),
      entry("search-menus-again", {
        patterns: ["Menu guidelines"],
        results: [
          { url: "https://docs.example.com/menus" },
          { url: "https://ui.example.org/sidebar" },
        ],
      }),
      // Codex batches queries; each one gets a chip.
      entry("search-codex", { patterns: ["sidebar width", "menu guidelines", "nested menus"] }),
      // An unmarked fetch from an older adapter is neither a page nor a search.
      entry("unmarked-fetch", { patterns: ["https://help.example.io/export"] }),
      entry("failed-search", { patterns: ["retention"] }, "failed"),
      entry("read-spec", { viewedDocument: { path: "/repo/spec.pdf", pages: "4-6" } }),
      entry("read-code", { toolName: "Read" }),
      entry("fetch-menus-again", { fetchedUrl: "http://docs.example.com/menus/#nav" }),
      entry("read-terms", { viewedDocument: { path: "/repo/terms.docx" } }),
      entry("read-spec-later", { viewedDocument: { path: "/repo/spec.pdf", pages: "9" } }),
      entry("failed-fetch", { fetchedUrl: "https://ui.example.org/sidebar" }, "failed"),
      entry("local-fetch", { fetchedUrl: "file:///repo/index.html" }),
    ]);
    expect(sources).toEqual([
      // Two ranges of one document show it without a range.
      { kind: "document", path: "/repo/spec.pdf" },
      { kind: "document", path: "/repo/terms.docx" },
      { kind: "page", url: "https://docs.example.com/menus" },
      {
        kind: "search",
        query: "menu guidelines",
        results: [
          { url: "https://docs.example.com/menus", title: "Navigation menus" },
          { url: "https://ui.example.org/sidebar" },
        ],
      },
      { kind: "search", query: "sidebar width", results: [] },
      { kind: "search", query: "nested menus", results: [] },
    ]);
  });

  it("leaves out the user's attachments, pages the run's reply links, and repeated searches", () => {
    const sources = [
      { kind: "document", path: "/data/attachments/own.pdf" },
      { kind: "document", path: "/repo/spec.pdf" },
      { kind: "page", url: "https://docs.example.com/menus" },
      { kind: "page", url: "https://ui.example.org/sidebar" },
      { kind: "page", url: "https://help.example.io/export" },
      { kind: "page", url: "https://wiki.example.org/Retention_(policy_(2026))" },
      { kind: "page", url: "https://wiki.example.org/Retention_" },
      { kind: "page", url: "https://docs.example.com/after-inline" },
      { kind: "page", url: "https://status.example.org/uptime/" },
      { kind: "search", query: "Menu guidelines", results: [] },
      { kind: "search", query: "sidebar width", results: [] },
    ] as const;
    const linked = assistantLinkedUrlKeysByRunId(
      [
        {
          role: "assistant",
          runId: "run-1",
          text: "See [the guide](https://docs.example.com/menus/) and **https://ui.example.org/sidebar**.",
        },
        {
          role: "assistant",
          runId: "run-1",
          // Code shows a URL as text, so its page keeps its chip.
          text: [
            "Run ``curl `-s` https://help.example.io/export``:",
            "```sh",
            "```not-a-close",
            "curl https://help.example.io/export",
            "```",
            "See [the policy](https://wiki.example.org/Retention_(policy_(2026))).",
            "```inline``` code, then https://docs.example.com/after-inline",
          ].join("\n"),
        },
        { role: "assistant", runId: "run-2", text: "https://help.example.io/export" },
        { role: "user", runId: "run-1", text: "https://help.example.io/export" },
      ],
      new Set(["run-1"]),
    );
    expect(
      omitViewedSources(sources, {
        attachmentIds: new Set(["own"]),
        linkedUrlKeys: linked.get("run-1") ?? new Set(),
        // An earlier strip of the run already shows this search and this page.
        shownSourceKeys: new Set(["search:menu guidelines", "page:status.example.org/uptime"]),
      }),
    ).toEqual([
      { kind: "document", path: "/repo/spec.pdf" },
      { kind: "page", url: "https://help.example.io/export" },
      { kind: "page", url: "https://wiki.example.org/Retention_" },
      { kind: "search", query: "sidebar width", results: [] },
    ]);
    expect(linked.has("run-2")).toBe(false);
  });

  it.each([
    [["a", "b", "c"], false, ["a", "b", "c"], 0],
    [["a", "b", "c", "d", "e"], false, ["a", "b", "c"], 2],
    [["a", "b", "c", "d", "e"], true, ["a", "b", "c", "d", "e"], 0],
  ] as const)("folds %j after 3, expanded %s", (sources, expanded, visible, hiddenCount) => {
    expect(foldViewedSources(sources, 3, expanded)).toEqual({ visible, hiddenCount });
  });
});
