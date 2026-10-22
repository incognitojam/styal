import { ProjectId, ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { deriveTimelineEntriesFromVisibleTurnItems, type WorkLogEntry } from "../../session-logic";
import {
  fileActionReviewRequestOf,
  workEntryDisplayLabel,
  workEntryIsVisibleInGroup,
} from "./MessagesTimeline.logic";

type CommandItem = Extract<OrchestrationV2TurnItem, { type: "command_execution" }>;
const now = DateTime.makeUnsafe("2026-10-21T12:00:00.000Z");
const projectId = ProjectId.make("project-1");
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
    ...(awaiting ? { awaitingApproval: { projectId, actionId: "install" } } : {}),
  },
});

describe("fileActionReviewRequestOf", () => {
  it("offers a review for an idle setup row awaiting approval, in its worktree", () => {
    expect(fileActionReviewRequestOf(setupRow("idle", true))).toEqual({
      projectId,
      actionId: "install",
      worktreePath: "/worktrees/feature",
    });
  });

  it("offers nothing once the row has moved on or never asked", () => {
    expect(fileActionReviewRequestOf(setupRow("completed", true))).toBeNull();
    expect(fileActionReviewRequestOf(setupRow("idle", false))).toBeNull();
    expect(fileActionReviewRequestOf(undefined)).toBeNull();
  });
});

describe("workEntryIsVisibleInGroup for setup rows awaiting approval", () => {
  const entry = (awaiting: boolean): WorkLogEntry => ({
    id: "setup:1",
    createdAt: "2026-10-21T12:00:00.000Z",
    label: "Install needs approval",
    tone: "info" as const,
    itemType: "command_execution" as const,
    toolLifecycleStatus: "idle" as const,
    sourceActivityKind: "setup-script.awaiting-approval",
    structuredPayload: setupRow("idle", awaiting),
  });

  it("keeps a row that asks for approval visible though nothing runs", () => {
    expect(workEntryIsVisibleInGroup(entry(true))).toBe(true);
  });
});

describe("setup row titles", () => {
  const rowTitle = (item: CommandItem) => {
    const [entry] = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [
        {
          item,
          position: 0,
          visibility: "local",
          sourceThreadId: item.threadId,
          sourceItemId: item.id,
        },
      ],
      optimisticMessages: [],
    });
    if (entry?.kind !== "work") throw new Error("Expected a work row");
    return workEntryDisplayLabel(entry.entry, "/worktrees/feature");
  };

  it("labels the row with the action's name rather than its command, in every state", () => {
    for (const [status, awaiting] of [
      ["idle", true],
      ["running", false],
      ["completed", false],
      ["failed", false],
      ["interrupted", false],
    ] as const) {
      expect(rowTitle(setupRow(status, awaiting))).toBe("Install");
    }
  });

  it("keeps the command as the label of an ordinary command row", () => {
    const { setupScript: _setupScript, ...command } = setupRow("completed", false);
    expect(rowTitle({ ...command, title: null })).toBe("./scripts/setup.sh");
  });
});
