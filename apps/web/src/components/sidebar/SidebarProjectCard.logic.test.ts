import { threadKey } from "@t3tools/client-runtime/state/entities";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { projectCardTotals } from "./SidebarProjectCard.logic";

const environmentId = EnvironmentId.make("env-local");

function shell(id: string, overrides: Partial<EnvironmentThreadShell> = {}) {
  return {
    environmentId,
    id: ThreadId.make(id),
    projectId: ProjectId.make("project-widgets"),
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make(id) },
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    runtime: null,
    pullRequests: [],
    ...overrides,
  } as EnvironmentThreadShell;
}

function usage(costUsd: number) {
  return {
    inputTokens: 100,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 10,
    reasoningTokens: 0,
    countedTurns: 1,
    turns: 1,
    partialTurns: 0,
    subagentTurns: 0,
    costUsd,
    pricedTurns: 1,
  } as NonNullable<EnvironmentThreadShell["tokenUsage"]>;
}

function pullRequest(number: number, state: "open" | "merged") {
  return {
    url: `https://github.com/acme/widgets/pull/${number}`,
    snapshot: { state },
  } as NonNullable<EnvironmentThreadShell["pullRequests"]>[number];
}

const running = { status: "running" } as EnvironmentThreadShell["runtime"];

describe("projectCardTotals", () => {
  it("counts the chat's usage and pull requests but not the chat as a thread", () => {
    const chat = shell("chat", {
      runtime: running,
      tokenUsage: usage(3),
      pullRequests: [pullRequest(1, "open")],
    });
    const totals = projectCardTotals(
      [
        chat,
        shell("working", { runtime: running, tokenUsage: usage(2) }),
        shell("question", { hasPendingUserInput: true }),
        shell("settled", { settledOverride: "settled", tokenUsage: usage(0.5) }),
        shell("archived", { archivedAt: "2026-11-01T00:00:00.000Z", tokenUsage: usage(9) }),
        shell("delegated-elsewhere", { runtime: running, tokenUsage: usage(4) }),
        shell("linked", {
          pullRequests: [pullRequest(1, "open"), pullRequest(2, "open"), pullRequest(3, "merged")],
        }),
      ],
      chat,
      new Set([threadKey({ environmentId, threadId: ThreadId.make("delegated-elsewhere") })]),
    );
    expect({ ...totals, usage: totals.usage?.costUsd }).toEqual({
      open: 3,
      settled: 1,
      working: 1,
      needYou: 1,
      openPullRequests: 2,
      usage: 5.5,
    });
  });

  it("counts the coordinator thread as an ordinary thread when there is no chat", () => {
    const totals = projectCardTotals([shell("chat", { runtime: running })], null, new Set());
    expect(totals).toMatchObject({ open: 1, working: 1 });
  });
});
