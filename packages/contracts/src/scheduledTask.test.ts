import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  MIN_SCHEDULED_TASK_INTERVAL_MS,
  type ScheduledTask,
  ScheduledTaskSchedule,
  ScheduledTaskUpsertSchedule,
  scheduledTaskThreads,
} from "./scheduledTask.ts";

const decodeSchedule = Schema.decodeUnknownSync(ScheduledTaskSchedule);
const decodeUpsertSchedule = Schema.decodeUnknownSync(ScheduledTaskUpsertSchedule);

describe("ScheduledTaskSchedule", () => {
  it("keeps legacy sub-minute persisted schedules readable", () => {
    expect(
      decodeSchedule({
        type: "interval",
        everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
      }),
    ).toEqual({
      type: "interval",
      everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
    });
  });

  it("accepts a one-time run only with an offset", () => {
    for (const runAt of ["2026-11-03T09:00Z", "2026-11-03T09:00:00.000-08:00"]) {
      expect(decodeUpsertSchedule({ type: "once", runAt })).toEqual({ type: "once", runAt });
    }
    for (const runAt of [
      "2026-11-03T09:00",
      "2026-13-03T09:00Z",
      "2026-02-30T09:00Z",
      "9999-12-31T23:30-01:00",
      "0000-01-01T00:00+00:01",
      "tomorrow",
    ]) {
      expect(() => decodeUpsertSchedule({ type: "once", runAt })).toThrow();
    }
  });
});

it.each(["literal", " ", "\t\n", "{{body.bad", "{{unknown.field}}"])(
  "rejects invalid dedupe template %s",
  (replayKey) => {
    expect(() => decodeUpsertSchedule({ type: "webhook", dedupe: { replayKey } })).toThrow();
    expect(() =>
      decodeUpsertSchedule({ type: "webhook", dedupe: { coalesceKey: replayKey } }),
    ).toThrow();
  },
);
describe("webhook filters", () => {
  const accepts = (filters: unknown) => {
    try {
      decodeUpsertSchedule({ type: "webhook", filters });
      return true;
    } catch {
      return false;
    }
  };

  it("rejects empty or unknown paths, unknown ops, and values that do not fit the op", () => {
    expect(accepts([{ path: "", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "  ", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "request", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "header.x-github-event", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "body.action", op: "in", value: "opened" }])).toBe(false);
    expect(accepts([{ path: "body.action", op: "in", value: [] }])).toBe(false);
    for (const value of ["", " opened", "opened ", "a,b"]) {
      expect(accepts([{ path: "body.action", op: "in", value: [value] }])).toBe(false);
    }
    expect(accepts([{ path: "body.label.name", op: "in", value: ["needs review"] }])).toBe(true);
    expect(accepts([{ path: "body.action", op: "equals" }])).toBe(false);
    expect(accepts([{ path: "body.action", op: "matches", value: "^opened$" }])).toBe(false);
  });
});

it("lists tasks that run in one thread without their prompts", () => {
  const task = (id: string, overrides: Partial<ScheduledTask>) =>
    ({
      id,
      title: `Task ${id}`,
      prompt: "A long prompt",
      enabled: true,
      schedule: { type: "interval", everyMs: 60_000 },
      threadId: null,
      createdAt: "2026-11-20T09:00:00.000Z",
      nextRunAt: null,
      lastRunAt: null,
      lastRunStatus: "never",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      ...overrides,
    }) as ScheduledTask;
  const result = scheduledTaskThreads({
    tasks: [
      task("bound", { threadId: "thread-1" as never, blockedByPolicy: "Webhooks are off." }),
      task("fresh", { threadId: "thread-2" as never, threadMode: "fresh_session" }),
      task("each-run", { threadId: "thread-3" as never, threadMode: "new_thread" }),
      task("unbound", {}),
    ],
    timeZone: "Europe/London",
  });
  expect(result).toEqual({
    tasks: [
      {
        id: "bound",
        title: "Task bound",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        threadId: "thread-1",
        createdAt: "2026-11-20T09:00:00.000Z",
        nextRunAt: null,
        lastRunAt: null,
        lastRunStatus: "never",
        blockedByPolicy: "Webhooks are off.",
      },
      expect.objectContaining({ id: "fresh", threadId: "thread-2" }),
    ],
    timeZone: "Europe/London",
  });
});
