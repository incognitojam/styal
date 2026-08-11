import { TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveThreadStatusPill } from "./components/Sidebar.logic";
import {
  clearThreadVisitBaseline,
  markThreadVisited,
  parsePersistedState,
  queueThreadVisitBaseline,
  resolveThreadVisitBaseline,
  type UiState,
} from "./uiStateStore";

const threadKey = "environment-a:thread-1";
const requestedAt = "2026-08-09T10:00:00.000Z";
const completedAt = "2026-08-09T10:05:00.000Z";

const completedThread = {
  hasActionableProposedPlan: false,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  interactionMode: "default" as const,
  latestTurn: {
    turnId: TurnId.make("turn-1"),
    state: "completed" as const,
    assistantMessageId: null,
    requestedAt,
    startedAt: "2026-08-09T10:00:01.000Z",
    completedAt,
  },
  session: null,
};

function statusPill(state: UiState) {
  return resolveThreadStatusPill({
    thread: {
      ...completedThread,
      lastVisitedAt: state.threadLastVisitedAtById[threadKey],
    },
  });
}

describe("first-turn unread completion state flow", () => {
  it("shows Done after leaving a submitted draft before its server shell arrives", () => {
    // Historical shells remain read when no live submission established a baseline.
    expect(statusPill(parsePersistedState({}))).toBeNull();

    // The accepted draft turn is queued before navigation, while no server shell exists yet.
    const queued = queueThreadVisitBaseline(parsePersistedState({}), threadKey);
    expect(queued.pendingThreadVisitBaselineKeys).toEqual([threadKey]);

    // The first server shell can already be complete; its requestedAt establishes the baseline.
    const baselined = resolveThreadVisitBaseline(queued, threadKey, requestedAt);

    expect(baselined.pendingThreadVisitBaselineKeys).toEqual([]);
    expect(statusPill(baselined)).toMatchObject({ label: "Completed" });

    // Opening the completed thread advances the visit marker and clears Done.
    expect(statusPill(markThreadVisited(baselined, threadKey, completedAt))).toBeNull();
  });

  it("drops the pending baseline when accepted thread creation is rolled back", () => {
    const queued = queueThreadVisitBaseline(parsePersistedState({}), threadKey);

    expect(clearThreadVisitBaseline(queued, threadKey).pendingThreadVisitBaselineKeys).toEqual([]);
  });
});
