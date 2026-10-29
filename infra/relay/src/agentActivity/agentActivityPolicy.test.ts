import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import { makeAggregateState } from "./agentActivityAggregate.ts";
import {
  attentionTransitionRows,
  delayedAlertIsDue,
  terminalTransitionRows,
  shouldAlertForActivity,
} from "./agentActivityAlerts.ts";
import { delayedAlertTrigger, isReadStateOnlyChange } from "./AgentActivityPublisher.ts";

const state: RelayAgentActivityState = {
  environmentId: EnvironmentId.make("env"),
  threadId: ThreadId.make("thread"),
  projectTitle: "Project",
  threadTitle: "Thread",
  modelTitle: "Model",
  headline: "Working",
  phase: "running",
  updatedAt: "1970-01-01T00:00:00.000Z",
  deepLink: "/threads/env/thread",
};
const preferences = {
  notificationsEnabled: true,
  liveActivitiesEnabled: true,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
};
const aggregate = (states: RelayAgentActivityState[]) =>
  makeAggregateState({ activeStates: states, terminalState: null, nowMs: 0 })!;

describe("shared agent activity policy", () => {
  it.each(["waiting_for_approval", "waiting_for_input"] as const)(
    "keeps an older %s ahead of five running rows",
    (phase) => {
      const running = Array.from({ length: 5 }, (_, i) => ({
        ...state,
        threadId: ThreadId.make(`running-${i}`),
      }));
      const waiting = { ...state, phase, updatedAt: "1969-12-31T23:59:00.000Z" };
      const next = aggregate([...running, waiting]);
      expect(next.activities[0]?.threadId).toBe(state.threadId);
      expect(next.activeCount).toBe(6);
      expect(next.activities).toHaveLength(5);
      expect(
        attentionTransitionRows({
          previousAggregate: aggregate(running),
          nextAggregate: next,
          preferences,
        }),
      ).toMatchObject([{ threadId: state.threadId }]);
    },
  );

  it("allows fresh unobserved completions for events, but not reconciliation or repeats", () => {
    const previousAggregate = aggregate([
      { ...state, threadId: ThreadId.make("old"), phase: "completed" },
    ]);
    const nextAggregate = aggregate([{ ...state, phase: "completed" }]);
    const input = { previousAggregate, nextAggregate, preferences, nowMs: 0 };
    expect(terminalTransitionRows(input)).toEqual([]);
    expect(terminalTransitionRows({ ...input, includeUnobserved: true })).toHaveLength(1);
    expect(
      terminalTransitionRows({
        ...input,
        includeUnobserved: true,
        previousAggregate: nextAggregate,
      }),
    ).toEqual([]);
    expect(terminalTransitionRows({ ...input, includeUnobserved: true, nowMs: 180_000 })).toEqual(
      [],
    );
  });

  it("distinguishes equal thread IDs across environments", () => {
    const waiting = { ...state, phase: "waiting_for_input" as const };
    const other = { ...waiting, environmentId: EnvironmentId.make("other") };
    expect(
      attentionTransitionRows({
        previousAggregate: aggregate([waiting]),
        nextAggregate: aggregate([waiting, other]),
        preferences,
      }),
    ).toMatchObject([{ environmentId: other.environmentId }]);
  });

  it("checks current permission, event preferences, and freshness together", () => {
    const input = { ...state, phase: "completed" as const, preferences, nowMs: 0 };
    expect(shouldAlertForActivity(input)).toBe(true);
    expect(
      shouldAlertForActivity({
        ...input,
        preferences: { ...preferences, notificationsEnabled: false },
      }),
    ).toBe(false);
    expect(
      shouldAlertForActivity({
        ...input,
        preferences: { ...preferences, notifyOnCompletion: false },
      }),
    ).toBe(false);
    expect(shouldAlertForActivity({ ...input, nowMs: 180_000 })).toBe(false);
  });

  describe("while the user is at a computer", () => {
    const delayed = { ...preferences, attendedAlertDelaySeconds: 600 };
    const waiting = { ...state, phase: "waiting_for_input" as const, attended: true };

    it("leaves the alert to the delayed job only when this device has a delay", () => {
      const input = { previousAggregate: aggregate([state]), nextAggregate: aggregate([waiting]) };
      expect(attentionTransitionRows({ ...input, preferences: delayed })).toEqual([]);
      expect(attentionTransitionRows({ ...input, preferences })).toHaveLength(1);
      expect(
        attentionTransitionRows({
          previousAggregate: aggregate([state]),
          nextAggregate: aggregate([{ ...waiting, attended: false }]),
          preferences: delayed,
        }),
      ).toHaveLength(1);
      const completed = { ...waiting, phase: "completed" as const };
      expect(shouldAlertForActivity({ ...completed, preferences: delayed, nowMs: 0 })).toBe(false);
    });

    it("queues a delayed alert when a thread enters an alert phase, not on republishes", () => {
      expect(delayedAlertTrigger(state, waiting)).toBe(waiting);
      expect(delayedAlertTrigger(null, waiting)).toBe(waiting);
      expect(delayedAlertTrigger(waiting, { ...waiting, threadTitle: "Renamed" })).toBeNull();
      expect(delayedAlertTrigger(state, { ...waiting, attended: false })).toBeNull();
      expect(delayedAlertTrigger(null, { ...state, attended: true })).toBeNull();
    });

    it("sends a delayed alert only if the thread is still waiting and unopened", () => {
      const raised = { phase: waiting.phase, updatedAt: "2026-10-29T10:00:00.000Z" };
      const current = { ...waiting, updatedAt: raised.updatedAt };
      const due = (overrides: Partial<RelayAgentActivityState>, prefs = delayed) =>
        delayedAlertIsDue({
          raised,
          current: { ...current, ...overrides },
          preferences: prefs,
          nowMs: Date.parse("2026-10-29T10:10:00.000Z"),
        });
      expect(due({})).toBe(true);
      expect(due({ lastVisitedAt: "2026-10-29T09:00:00.000Z" })).toBe(true);
      // Metadata changes move updatedAt without resolving anything.
      expect(due({ updatedAt: "2026-10-29T10:05:00.000Z" })).toBe(true);
      expect(due({ lastVisitedAt: raised.updatedAt })).toBe(false);
      expect(due({ phase: "running" })).toBe(false);
      expect(due({}, { ...delayed, notifyOnInput: false })).toBe(false);
      expect(due({}, { ...delayed, notificationsEnabled: false })).toBe(false);
      expect(delayedAlertIsDue({ raised, current: null, preferences: delayed, nowMs: 0 })).toBe(
        false,
      );
    });

    it("stores visits without redelivering, but redelivers identical republishes", () => {
      const visited = { ...waiting, lastVisitedAt: "2026-10-29T10:01:00.000Z" };
      expect(isReadStateOnlyChange(waiting, visited)).toBe(true);
      expect(isReadStateOnlyChange(waiting, { ...waiting, attended: false })).toBe(true);
      expect(isReadStateOnlyChange(waiting, waiting)).toBe(false);
      expect(isReadStateOnlyChange(null, waiting)).toBe(false);
      expect(isReadStateOnlyChange(waiting, { ...visited, phase: "running" })).toBe(false);
    });
  });
});
