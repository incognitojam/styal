import { ProjectId, ThreadId, RuntimeRequestId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "@effect/vitest";
import { derivePendingBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { summarizeHostSessions, withProjects } from "./HostActivity.ts";

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
      affected: [],
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
      affected: [
        {
          projectId: "project",
          thread: {
            threadId: active.id,
            title: active.title,
            reasons: ["running", "monitor"],
            continuable: false,
          },
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
  it("does not count watches or delegated child threads, which outlive a restart", () => {
    const watches = derivePendingBackgroundWork({
      latestRun: null,
      providerThreads: [],
      turnItems: [],
      pullRequests: [
        {
          host: "github.com",
          repository: "acme/app",
          number: 7,
          url: "https://github.com/acme/app/pull/7",
          source: "agent",
          snapshot: null,
          watch: {
            startedAt: "2026-10-05T00:00:00.000Z",
            headSha: null,
            failedChecks: [],
            passed: false,
            passedChecks: [],
            remarksThrough: "2026-10-05T00:00:00.000Z",
            remarkIds: [],
            conflicting: false,
            wakes: 0,
          },
        },
      ],
    });
    expect(watches).toHaveLength(1);
    const summary = summarizeHostSessions([
      { ...thread("watching"), status: "completed", pendingBackgroundTasks: watches },
      {
        ...thread("both"),
        status: "completed",
        pendingBackgroundTasks: [...watches, { taskId: "shell", kind: "command" }],
      },
      {
        ...thread("delegating"),
        status: "completed",
        pendingBackgroundTasks: [
          {
            taskId: "delegated",
            kind: "subagent",
            origin: "app_owned",
            childThreadId: ThreadId.make("child"),
          },
        ],
      },
      {
        ...thread("native"),
        status: "completed",
        pendingBackgroundTasks: [
          {
            taskId: "native",
            kind: "subagent",
            origin: "provider_native",
            childThreadId: ThreadId.make("native-child"),
          },
        ],
      },
      {
        ...thread("legacy"),
        status: "completed",
        pendingBackgroundTasks: [
          { taskId: "legacy", kind: "subagent", childThreadId: ThreadId.make("legacy-child") },
        ],
      },
      {
        ...thread("running-parent"),
        status: "running",
        pendingBackgroundTasks: [
          {
            taskId: "delegated",
            kind: "subagent",
            origin: "app_owned",
            childThreadId: ThreadId.make("child"),
          },
        ],
      },
    ]);
    expect(summary).toMatchObject({ activeSessions: 4, waitingSessions: 0 });
    expect(summary.affected.map(({ thread }) => [thread.threadId, thread.reasons])).toEqual([
      ["both", ["command"]],
      ["native", ["subagent"]],
      ["legacy", ["subagent"]],
      ["running-parent", ["running"]],
    ]);
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

const sampleProject = {
  projectId: ProjectId.make("project"),
  title: "Sample project",
  workspaceRoot: "/workspace/sample",
  faviconPath: "brand/icon.svg",
  projectIcon: { kind: "emoji" as const, emoji: "🌿" },
};

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
    );
    expect(activity).toMatchObject({
      activeSessions: 4,
      waitingSessions: 3,
      continuableSessions: 2,
    });
    expect(withProjects(activity.affected, [sampleProject])).toEqual(
      [
        {
          threadId: "preparing",
          title: "Thread preparing",
          reasons: ["preparing"],
          continuable: false,
        },
        {
          threadId: "starting",
          title: "Thread starting",
          reasons: ["starting"],
          continuable: false,
        },
        {
          threadId: "running",
          title: "Thread running",
          reasons: ["running"],
          continuable: true,
        },
        {
          threadId: "input",
          title: "Thread input",
          reasons: ["input"],
          continuable: false,
        },
        {
          threadId: "approval",
          title: "Thread approval",
          reasons: ["approval"],
          continuable: false,
        },
        {
          threadId: "waiting",
          title: "Thread waiting",
          reasons: ["waiting"],
          continuable: false,
        },
        {
          threadId: "background",
          title: "Thread background",
          reasons: ["monitor", "command", "subagent", "background_task"],
          continuable: true,
        },
      ].map((thread) => ({
        ...thread,
        project: {
          id: sampleProject.projectId,
          title: sampleProject.title,
          workspaceRoot: sampleProject.workspaceRoot,
          faviconPath: sampleProject.faviconPath,
          projectIcon: sampleProject.projectIcon,
        },
      })),
    );
  });

  it("leaves project identity off threads whose project is gone", () => {
    const { affected } = summarizeHostSessions([{ ...thread("running"), status: "running" }]);
    expect(withProjects(affected, [])).toEqual([
      { threadId: "running", title: "Thread running", reasons: ["running"], continuable: false },
    ]);
  });
});
