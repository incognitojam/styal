import { describe, expect, it } from "@effect/vitest";

import type {
  EnvironmentId,
  OrchestrationV2ThreadShell,
  Project,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { MessageId, ProviderInstanceId, RuntimeRequestId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  projectThreadAwarenessV2,
  threadAttentionSubjects,
  hasNewThreadAttention,
} from "./agentAwareness.ts";

const NOW = "2026-05-22T12:00:00.000Z";

const project = {
  title: "t3code",
} satisfies Pick<Project, "title">;

describe("projectThreadAwarenessV2", () => {
  const updatedAt = DateTime.makeUnsafe(NOW);
  const v2Thread = (
    overrides: Partial<
      Pick<
        OrchestrationV2ThreadShell,
        | "latestRunStartedByAgent"
        | "reportTo"
        | "delegatedFrom"
        | "activityRunStatus"
        | "latestRunBackgroundWake"
        | "latestRunStopRequested"
        | "status"
        | "pendingBackgroundTasks"
        | "pendingRuntimeRequest"
        | "lineage"
        | "workflowRuns"
        | "settledOverride"
      >
    > = {},
  ) => ({
    id: "thread-2" as ThreadId,
    projectId: "project-1" as ProjectId,
    lineage: {
      rootThreadId: "thread-2" as ThreadId,
      parentThreadId: null,
      relationshipToParent: null,
    },
    title: "Integrate orchestration",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    status: "running" as const,
    pendingRuntimeRequest: null,
    settledOverride: null,
    updatedAt,
    ...overrides,
  });

  it("does not announce completion after a manual stop", () => {
    const input = {
      environmentId: "env-1" as EnvironmentId,
      project,
      thread: v2Thread({ status: "completed" }),
    };
    expect(projectThreadAwarenessV2(input)?.phase).toBe("completed");
    expect(
      projectThreadAwarenessV2({
        ...input,
        thread: { ...input.thread, latestRunStopRequested: true },
      }),
    ).toBeNull();
  });

  it.each([
    ["holds a wake run", true, [{ taskId: "watch", kind: "monitor" as const }], "running"],
    ["completes a wake run once its monitor ends", true, [], "completed"],
    [
      "holds a wake run while a monitor remains beside other work",
      true,
      [
        { taskId: "build", kind: "command" as const },
        { taskId: "watch", kind: "monitor" as const },
      ],
      "running",
    ],
    [
      "completes a wake run with only a command pending",
      true,
      [{ taskId: "build", kind: "command" as const }],
      "completed",
    ],
    [
      "completes a run the user started",
      false,
      [{ taskId: "watch", kind: "monitor" as const }],
      "completed",
    ],
  ] as const)("%s while a monitor wakes the thread", (_, latestRunBackgroundWake, tasks, phase) => {
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: v2Thread({
          status: "completed",
          latestRunBackgroundWake,
          pendingBackgroundTasks: [...tasks],
        }),
      })?.phase,
    ).toBe(phase);
  });

  it.each(
    [
      { name: "provider subagent", child: true, creationSource: "provider" },
      { name: "local delegated child", child: true, creationSource: "mcp" },
      { name: "side chat", sideChat: true },
      { name: "local reportBack launch", reportTo: { threadId: "coordinator" as ThreadId } },
      {
        name: "remote delegate",
        delegatedFrom: {
          environmentId: "other" as EnvironmentId,
          threadId: "coordinator" as ThreadId,
          title: "Coordinator",
        },
      },
      { name: "agent follow-up", reportTo: { threadId: "coordinator" as ThreadId } },
      { name: "agent wake", reportTo: { threadId: "coordinator" as ThreadId } },
      {
        name: "user message to a reporting launch",
        reportTo: { threadId: "coordinator" as ThreadId },
        person: true,
      },
      {
        name: "user message to a remote delegate",
        delegatedFrom: {
          environmentId: "other" as EnvironmentId,
          threadId: "coordinator" as ThreadId,
          title: "Coordinator",
        },
        person: true,
      },
      {
        name: "hand-started coordinator project thread",
        reportTo: { threadId: "coordinator" as ThreadId, source: "project-coordinator" as const },
        person: true,
      },
      {
        name: "human server-origin answer to a reporting launch",
        reportTo: { threadId: "coordinator" as ThreadId },
        person: true,
      },
      { name: "agent run without a report target" },
      {
        name: "older server without run authorship",
        reportTo: { threadId: "coordinator" as ThreadId },
        person: undefined,
      },
    ].map((entry) => ({
      person: false,
      child: false,
      sideChat: false,
      reportTo: undefined,
      delegatedFrom: undefined,
      ...entry,
    })),
  )(
    "publishes only user-facing activity for $name",
    ({ child, sideChat, reportTo, delegatedFrom, person }) => {
      for (const phase of ["running", "completed", "failed", "user_input", "command"] as const) {
        const state = projectThreadAwarenessV2({
          environmentId: "env-1" as EnvironmentId,
          project,
          thread: v2Thread({
            status: phase === "user_input" || phase === "command" ? "completed" : phase,
            latestRunStartedByAgent: person === undefined ? undefined : !person,
            reportTo,
            delegatedFrom,
            lineage: {
              rootThreadId: "parent" as ThreadId,
              parentThreadId: child || sideChat ? ("parent" as ThreadId) : null,
              relationshipToParent: child ? "subagent" : null,
              sideChat,
            },
            pendingRuntimeRequest:
              phase === "user_input" || phase === "command"
                ? {
                    id: RuntimeRequestId.make("request"),
                    kind: phase,
                    createdAt: updatedAt,
                  }
                : null,
          }),
        });
        const hidden =
          child ||
          sideChat ||
          (phase === "completed" &&
            person === false &&
            (reportTo != null || delegatedFrom != null));
        expect(state?.phase ?? null).toBe(
          hidden
            ? null
            : phase === "user_input"
              ? "waiting_for_input"
              : phase === "command"
                ? "waiting_for_approval"
                : phase,
        );
      }
    },
  );

  it("keeps an older activity run visible over a newer cancelled run", () => {
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: v2Thread({ status: "cancelled", activityRunStatus: "running" }),
      }),
    ).toMatchObject({ phase: "running", headline: "Agent is working" });
  });

  it.each([
    ["completed", "completed", false],
    ["failed", "failed", false],
    ["monitor-held", "completed", true],
  ] as const)("removes settled %s work", (_, status, latestRunBackgroundWake) => {
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: v2Thread({
          status,
          settledOverride: "settled",
          latestRunBackgroundWake,
          pendingBackgroundTasks: [{ taskId: "watch", kind: "monitor" }],
        }),
      }),
    ).toBeNull();
  });

  it.each(["starting", "running", "waiting"] as const)(
    "keeps settled %s work visible",
    (status) => {
      expect(
        projectThreadAwarenessV2({
          environmentId: "env-1" as EnvironmentId,
          project,
          thread: v2Thread({ status, settledOverride: "settled" }),
        }),
      ).toMatchObject({ phase: status === "starting" ? "starting" : "running" });
    },
  );

  it.each(["user_input", "command"] as const)(
    "keeps a settled terminal thread with a pending %s request",
    (kind) => {
      expect(
        projectThreadAwarenessV2({
          environmentId: "env-1" as EnvironmentId,
          project,
          thread: v2Thread({
            status: "completed",
            settledOverride: "settled",
            pendingRuntimeRequest: {
              id: RuntimeRequestId.make("request-settled"),
              kind,
              createdAt: updatedAt,
            },
          }),
        }),
      ).toMatchObject({
        phase: kind === "user_input" ? "waiting_for_input" : "waiting_for_approval",
      });
    },
  );

  it("keeps settled work held open by an awaited monitor", () => {
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: v2Thread({
          status: "completed",
          settledOverride: "settled",
          pendingBackgroundTasks: [{ taskId: "watch", kind: "monitor", awaited: true }],
        }),
      }),
    ).toMatchObject({ phase: "running" });
  });

  it.each([
    ["only a dev server", "completed", [{ taskId: "dev", kind: "command" }]],
    ["a dev server's watchdog monitor", "completed", [{ taskId: "watch", kind: "monitor" }]],
    [
      "a command the agent waits on",
      "running",
      [{ taskId: "tests", kind: "command", awaited: true }],
    ],
    [
      "a dev server and a subagent",
      "running",
      [
        { taskId: "dev", kind: "command" },
        { taskId: "review", kind: "subagent" },
      ],
    ],
  ] as const)("reports a completed run waiting on %s as %s", (_case, phase, tasks) => {
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: v2Thread({ status: "completed", pendingBackgroundTasks: tasks }),
      }),
    ).toMatchObject({ phase });
  });

  it("asks for approval while a watched run waits for the user's deployment review", () => {
    const watch = {
      host: "github.com",
      repository: "acme/web",
      runId: 40,
      url: "https://github.com/acme/web/actions/runs/40",
      name: "Promote #3",
      startedAt: NOW,
    };
    const awareness = (workflowRuns: OrchestrationV2ThreadShell["workflowRuns"]) =>
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: v2Thread({ status: "completed", workflowRuns }),
      });
    expect(
      awareness([{ ...watch, review: { environments: [{ id: 21, name: "production" }] } }]),
    ).toMatchObject({ phase: "waiting_for_approval", headline: "Approval needed" });
    expect(awareness([watch])).toMatchObject({ phase: "completed" });
  });

  it("reports an async question as input while the run keeps working", () => {
    const input = {
      environmentId: "env-1" as EnvironmentId,
      project,
      thread: v2Thread({
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("request-async"),
          kind: "user_input",
          createdAt: updatedAt,
          blocking: false,
        },
      }),
    };
    expect(projectThreadAwarenessV2(input)).toMatchObject({
      phase: "waiting_for_input",
      headline: "Waiting for input",
    });
  });

  it("does not present authentication refreshes as user approvals", () => {
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: v2Thread({
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("request-auth-refresh"),
            kind: "auth_refresh",
            createdAt: updatedAt,
          },
        }),
      }),
    ).toMatchObject({ phase: "running", headline: "Agent is working" });
  });

  it.each([
    ["names the project for its coordinator", true, "thread-2", "t3code"],
    [
      "keeps the title of a thread that is not the coordinator",
      true,
      "thread-9",
      "Integrate orchestration",
    ],
    [
      "keeps the title while project coordinators are off",
      false,
      "thread-2",
      "Integrate orchestration",
    ],
  ])("%s", (_, projectCoordinatorsEnabled, coordinatorId, threadTitle) => {
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: v2Thread({ status: "completed" }),
        settings: {
          projectCoordinatorsEnabled,
          projectCoordinators: {
            ["project-1" as ProjectId]: { threadId: coordinatorId as ThreadId },
          },
        },
      })?.threadTitle,
    ).toBe(threadTitle);
  });
});

describe("threadAttentionSubjects", () => {
  it("keeps the same report question across turns and distinguishes the next version", () => {
    const thread = {
      pendingRuntimeRequest: null,
      openReportQuestionCount: 1,
      openReportQuestionIds: [MessageId.make("report-v1")],
      latestOpenReportQuestionAt: DateTime.makeUnsafe(NOW),
    };
    const first = threadAttentionSubjects(thread);
    expect(first).toEqual(["report-v1"]);
    expect(hasNewThreadAttention(first, first)).toBe(false);
    expect(hasNewThreadAttention(first, ["report-v1", "report-v2"])).toBe(true);
    expect(hasNewThreadAttention(["report-v1", "report-v2"], first)).toBe(false);
    expect(threadAttentionSubjects({ ...thread })).toEqual(first);
    expect(
      threadAttentionSubjects({
        ...thread,
        openReportQuestionIds: [MessageId.make("report-v2")],
      }),
    ).not.toEqual(first);
    expect(
      threadAttentionSubjects({ ...thread, openReportQuestionCount: 0, openReportQuestionIds: [] }),
    ).toEqual([]);
    const awareness = (status: "running" | "completed", report = thread) =>
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: {
          ...report,
          id: "report-thread" as ThreadId,
          projectId: "project-1" as ProjectId,
          lineage: {
            rootThreadId: "report-thread" as ThreadId,
            parentThreadId: null,
            relationshipToParent: null,
          },
          title: "Report",
          settledOverride: null,
          modelSelection: { instanceId: ProviderInstanceId.make("devReplay"), model: "showcase" },
          updatedAt: DateTime.add(report.latestOpenReportQuestionAt, { hours: 1 }),
          status,
        },
      });
    expect(awareness("running")).toMatchObject({ phase: "waiting_for_input", attentionIds: first });
    expect(awareness("completed")).toMatchObject({
      phase: "waiting_for_input",
      attentionIds: first,
    });
    expect(
      awareness("completed", {
        ...thread,
        openReportQuestionIds: [MessageId.make("report-v2")],
      }),
    ).toMatchObject({ attentionIds: ["report-v2"] });
  });
});
