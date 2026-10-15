import { ProjectId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { summarizeHostSessions } from "./HostActivity.ts";

const thread = (id: string) => ({
  id: ThreadId.make(id),
  title: `Thread ${id}`,
  projectId: ProjectId.make("project"),
  status: "idle" as const,
  pendingRuntimeRequest: null,
  pendingBackgroundTasks: [],
});
describe("host session activity", () => {
  it("does not count open idle sessions as running work", () => {
    expect(summarizeHostSessions([thread("idle")])).toEqual({
      activeSessions: 0,
      continuableSessions: 0,
      waitingSessions: 0,
      threads: [],
    });
  });
  it("deduplicates a running provider thread and its background work", () => {
    const active = {
      ...thread("active"),
      status: "running" as const,
      pendingBackgroundTasks: [{ taskId: "task", kind: "monitor" as const }],
    };
    expect(summarizeHostSessions([active])).toEqual({
      activeSessions: 1,
      continuableSessions: 0,
      waitingSessions: 0,
      threads: [
        {
          threadId: active.id,
          title: active.title,
          projectTitle: null,
          reasons: ["running", "monitor"],
          continuable: false,
        },
      ],
    });
  });
  it("counts input waits separately and protects monitoring", () => {
    expect(
      summarizeHostSessions([
        { ...thread("approval"), status: "waiting" },
        { ...thread("input"), status: "waiting" },
        { ...thread("monitor"), pendingBackgroundTasks: [{ taskId: "monitor", kind: "monitor" }] },
      ]),
    ).toMatchObject({ activeSessions: 1, continuableSessions: 0, waitingSessions: 2 });
  });
  it("protects dispatched turns while preparing or starting", () => {
    expect(
      summarizeHostSessions([
        { ...thread("preparing"), status: "preparing" },
        { ...thread("starting"), status: "starting" },
      ]),
    ).toMatchObject({ activeSessions: 2, continuableSessions: 0, waitingSessions: 0 });
  });
  it("counts continuable threads only among active threads", () => {
    expect(
      summarizeHostSessions(
        [
          { ...thread("active"), status: "running" },
          { ...thread("wait"), status: "waiting" },
        ],
        new Set(["active", "wait", "idle"]),
      ),
    ).toMatchObject({ activeSessions: 1, continuableSessions: 1, waitingSessions: 1 });
  });
});

const pendingRequest = (kind: "user_input" | "permission") => ({
  id: RuntimeRequestId.make("request"),
  kind,
  createdAt: DateTime.makeUnsafe("2026-10-15T12:00:00.000Z"),
});

describe("host thread details", () => {
  it("names each affected thread and explains all its work from the count's snapshot", () => {
    const activity = summarizeHostSessions(
      [
        thread("idle"),
        { ...thread("preparing"), status: "preparing" },
        { ...thread("starting"), status: "starting" },
        { ...thread("running"), status: "running" },
        {
          ...thread("input"),
          status: "running",
          pendingRuntimeRequest: pendingRequest("user_input"),
        },
        {
          ...thread("approval"),
          status: "waiting",
          pendingRuntimeRequest: pendingRequest("permission"),
        },
        { ...thread("waiting"), status: "waiting" },
        {
          ...thread("background"),
          status: "completed",
          pendingBackgroundTasks: [
            { taskId: "monitor-1", kind: "monitor" },
            { taskId: "monitor-2", kind: "monitor" },
            { taskId: "command", kind: "command" },
            { taskId: "subagent", kind: "subagent" },
            { taskId: "task", kind: "background_task" },
          ],
        },
      ],
      new Set(["running", "input", "background"]),
      new Map([["project", "Sample project"]]),
    );
    expect(activity).toMatchObject({
      activeSessions: 4,
      waitingSessions: 3,
      continuableSessions: 2,
    });
    expect(activity.threads).toEqual([
      {
        threadId: "preparing",
        title: "Thread preparing",
        projectTitle: "Sample project",
        reasons: ["preparing"],
        continuable: false,
      },
      {
        threadId: "starting",
        title: "Thread starting",
        projectTitle: "Sample project",
        reasons: ["starting"],
        continuable: false,
      },
      {
        threadId: "running",
        title: "Thread running",
        projectTitle: "Sample project",
        reasons: ["running"],
        continuable: true,
      },
      {
        threadId: "input",
        title: "Thread input",
        projectTitle: "Sample project",
        reasons: ["input"],
        continuable: false,
      },
      {
        threadId: "approval",
        title: "Thread approval",
        projectTitle: "Sample project",
        reasons: ["approval"],
        continuable: false,
      },
      {
        threadId: "waiting",
        title: "Thread waiting",
        projectTitle: "Sample project",
        reasons: ["waiting"],
        continuable: false,
      },
      {
        threadId: "background",
        title: "Thread background",
        projectTitle: "Sample project",
        reasons: ["monitor", "command", "subagent", "background_task"],
        continuable: true,
      },
    ]);
  });
});
