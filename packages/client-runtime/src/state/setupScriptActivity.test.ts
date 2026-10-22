import { ProjectId, ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { setupScriptActivityLabel, setupScriptAwaitingApproval } from "./setupScriptActivity.ts";

type CommandItem = Extract<OrchestrationV2TurnItem, { type: "command_execution" }>;
const now = DateTime.makeUnsafe("2026-10-21T12:00:00.000Z");
const setupRow = (status: CommandItem["status"], awaiting: boolean): CommandItem => ({
  id: TurnItemId.make("setup:run-1"),
  threadId: ThreadId.make("thread-1"),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status,
  title: "Install",
  startedAt: now,
  completedAt: null,
  updatedAt: now,
  type: "command_execution",
  input: "./scripts/setup.sh",
  setupScript: {
    runId: "run-1",
    scriptId: "install",
    scriptName: "Install",
    terminalId: "setup-install",
    worktreePath: "/worktrees/feature",
    ...(awaiting
      ? { awaitingApproval: { projectId: ProjectId.make("project-1"), actionId: "install" } }
      : {}),
  },
});

describe("setup script activity", () => {
  it("reads an idle row with an approval request as needing approval", () => {
    const row = setupRow("idle", true);
    expect(setupScriptAwaitingApproval(row)).toBe(true);
    expect(setupScriptActivityLabel(row)).toBe("Install needs approval");
  });

  it("keeps the usual states for rows that ran", () => {
    expect(setupScriptAwaitingApproval(setupRow("running", false))).toBe(false);
    expect(setupScriptActivityLabel(setupRow("running", false))).toBe("Install running");
    expect(setupScriptActivityLabel(setupRow("completed", false))).toBe("Install completed");
  });
});
