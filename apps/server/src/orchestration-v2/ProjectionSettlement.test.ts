import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  RuntimeRequestId,
  ScheduledTaskId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  isAutoSettlementCandidate,
  isSnoozed,
  resolveAutoSettlementAt,
} from "./ThreadSettlementService.ts";

const layerSql = ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
const now = DateTime.makeUnsafe("2026-09-04T12:00:00Z");
const old = DateTime.subtract(now, { days: 10 });
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "test-model" };

const createThread = Effect.fn(function* (
  name: string,
  overrides: Partial<OrchestrationV2AppThread> = {},
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const threadId = ThreadId.make(`thread:settlement:${name}`);
  const thread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: ProjectId.make("project:settlement"),
    title: name,
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "feature",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: old,
    updatedAt: old,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...overrides,
  };
  yield* store.apply({
    id: EventId.make(`event:${threadId}`),
    type: "thread.created",
    threadId,
    occurredAt: old,
    payload: thread,
  });
  return threadId;
});

const createRun = Effect.fn(function* (
  threadId: ThreadId,
  status: OrchestrationV2Run["status"] = "completed",
  ordinal = 1,
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const runId = RunId.make(`run:${threadId}:${ordinal}`);
  yield* store.apply({
    id: EventId.make(`event:${runId}`),
    type: "run.created",
    threadId,
    occurredAt: old,
    payload: {
      id: runId,
      threadId,
      ordinal,
      providerInstanceId,
      modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make(`message:${runId}`),
      rootNodeId: null,
      activeAttemptId: null,
      status,
      requestedAt: old,
      startedAt: status === "queued" ? null : old,
      completedAt: ["completed", "rolled_back", "failed"].includes(status) ? old : null,
      checkpointId: null,
      contextHandoffId: null,
    },
  });
  return runId;
});

const createItem = Effect.fn(function* (
  threadId: ThreadId,
  runId: RunId,
  status: "idle" | "running" | "completed",
  persistent = false,
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  yield* store.apply({
    id: EventId.make(`event:item:${runId}`),
    type: "turn-item.updated",
    threadId,
    occurredAt: old,
    payload: {
      id: TurnItemId.make(`item:${runId}`),
      threadId,
      runId,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      type: "dynamic_tool",
      status,
      title: null,
      startedAt: old,
      completedAt: status === "completed" ? old : null,
      updatedAt: old,
      toolName: "background",
      input: persistent ? { persistent: true } : null,
      output: null,
    },
  });
});

it.effect.each([["sql", layerSql]] as const)(
  "%s: pending approvals wake a snoozed question even with older creation times",
  ([, testLayer]) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = yield* createThread("snoozed-question-approval", {
        snoozedAt: now,
        snoozedUntil: DateTime.add(now, { days: 1 }),
      });
      const question: OrchestrationV2RuntimeRequest = {
        id: RuntimeRequestId.make("question"),
        nodeId: NodeId.make("node:question"),
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "message" },
        createdAt: DateTime.subtract(now, { hours: 1 }),
        resolvedAt: null,
      };
      const approval: OrchestrationV2RuntimeRequest = {
        ...question,
        id: RuntimeRequestId.make("approval"),
        kind: "command",
        createdAt: old,
      };
      const newerApproval = {
        ...approval,
        id: RuntimeRequestId.make("newer-approval"),
        createdAt: DateTime.add(old, { hours: 1 }),
      };
      const setRequest = (request: OrchestrationV2RuntimeRequest) =>
        store.apply({
          id: EventId.make(`event:${request.id}:${request.status}`),
          type: "runtime-request.updated",
          threadId,
          occurredAt: now,
          payload: request,
        });
      const assertPending = (expected: RuntimeRequestId, snoozed: boolean) =>
        Effect.gen(function* () {
          const snapshot = yield* store.getShellSnapshot();
          const shell = snapshot.threads.find((thread) => thread.id === threadId)!;
          const projection = yield* store.getThreadProjection(threadId);
          for (const candidate of [shell, ProjectionStore.threadShellFromProjection(projection)]) {
            assert.equal(candidate.pendingRuntimeRequest?.id, expected);
            assert.equal(isSnoozed(candidate, DateTime.toEpochMillis(now)), snoozed);
          }
        });
      yield* setRequest({
        ...question,
        id: RuntimeRequestId.make("older-question"),
        createdAt: old,
      });
      yield* setRequest(question);
      yield* assertPending(question.id, true);

      // A request becoming pending can retain a creation time older than the snooze.
      yield* setRequest(approval);
      yield* assertPending(approval.id, false);
      yield* setRequest(newerApproval);
      yield* assertPending(newerApproval.id, false);
      yield* setRequest({ ...newerApproval, status: "resolved", resolvedAt: now });
      yield* assertPending(approval.id, false);
      yield* setRequest({ ...approval, status: "resolved", resolvedAt: now });
      yield* assertPending(question.id, true);
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "sql: discovers settlement work with the same activity and background semantics as the shell",
  () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const idle = yield* createThread("idle");
      const completed = yield* createThread("completed");
      yield* createRun(completed);
      for (const [name, overrides] of [
        ["archived", { archivedAt: old }],
        ["deleted", { deletedAt: old }],
        ["settled", { settledOverride: "settled" }],
        ["unsettled", { settledOverride: "active" }],
        ["pinned", { pinnedAt: old }],
        ["auto-settle-disabled", { autoSettleDisabledAt: old }],
      ] satisfies ReadonlyArray<readonly [string, Partial<OrchestrationV2AppThread>]>) {
        yield* createRun(yield* createThread(name, overrides));
      }
      for (const status of ["preparing", "starting", "running", "waiting"] as const) {
        yield* createRun(yield* createThread(status), status);
      }
      const queued = yield* createThread("queued");
      yield* createRun(queued, "queued");
      const blocked = yield* createThread("blocked");
      yield* store.apply({
        id: EventId.make("event:settlement:request"),
        type: "runtime-request.updated",
        threadId: blocked,
        occurredAt: old,
        payload: {
          id: RuntimeRequestId.make("request:settlement"),
          nodeId: NodeId.make("node:settlement"),
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input",
          status: "pending",
          responseCapability: { type: "not_resumable", reason: "Process stopped" },
          createdAt: old,
          resolvedAt: null,
        },
      });
      const recent = yield* createThread("recent-message");
      yield* createRun(recent);
      yield* store.apply({
        id: EventId.make("event:settlement:message"),
        type: "message.updated",
        threadId: recent,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: MessageId.make("message:settlement:recent"),
          threadId: recent,
          runId: null,
          nodeId: null,
          role: "user",
          text: "Next turn",
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* createRun(
        yield* createThread("snoozed", {
          snoozedUntil: DateTime.add(now, { days: 1 }),
          snoozedAt: now,
        }),
      );
      const woke = yield* createThread("woke", {
        snoozedUntil: DateTime.add(now, { days: 1 }),
        snoozedAt: DateTime.subtract(old, { days: 1 }),
      });
      yield* createRun(woke, "failed");
      const background = yield* createThread("idle-background");
      yield* createItem(background, yield* createRun(background), "idle");
      const persistent = yield* createThread("persistent-monitor");
      yield* createItem(persistent, yield* createRun(persistent), "running", true);
      const rolledBack = yield* createThread("rolled-back-background");
      yield* createItem(rolledBack, yield* createRun(rolledBack, "rolled_back"), "running");
      yield* createRun(rolledBack, "completed", 2);
      const roster = yield* createThread("provider-roster");
      yield* createRun(roster);
      yield* store.apply({
        id: EventId.make("event:settlement:roster"),
        type: "provider-thread.updated",
        threadId: roster,
        occurredAt: old,
        payload: {
          id: ProviderThreadId.make("provider-thread:settlement"),
          appThreadId: roster,
          ownerNodeId: null,
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId,
          providerSessionId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: null,
          createdAt: old,
          updatedAt: old,
          pendingBackgroundTasks: [{ taskId: "running-task", kind: "subagent" }],
        },
      });
      const reportThread = yield* createThread("report-question");
      yield* createRun(reportThread);
      yield* store.apply({
        id: EventId.make("event:settlement:report"),
        type: "message.updated",
        threadId: reportThread,
        occurredAt: now,
        payload: {
          createdBy: "agent",
          creationSource: "mcp",
          id: MessageId.make("message:settlement:report"),
          threadId: reportThread,
          runId: null,
          nodeId: null,
          role: "assistant",
          text: "Choose a release",
          report: {
            key: "release",
            version: 1,
            title: "Release",
            question: "Ship?",
            answers: ["Ship", "Wait"],
          },
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({ coordinatorReportsEnabled: false });
      assert.equal((yield* store.getThreadShell(reportThread))?.openReportQuestionCount, 0);
      assert.isNull((yield* store.getThreadShell(reportThread))?.latestOpenReportQuestionAt);
      assert.equal(
        (yield* store.getShellSnapshot()).threads.find((thread) => thread.id === reportThread)
          ?.openReportQuestionCount,
        0,
      );
      const disabledCandidates = yield* store.getSettlementCandidates(reportThread);
      assert.isTrue(
        disabledCandidates.some(
          (thread) =>
            thread.id === reportThread &&
            isAutoSettlementCandidate(thread, DateTime.toEpochMillis(now)),
        ),
      );
      assert.isTrue(
        isSnoozed(
          {
            ...(yield* store.getThreadShell(reportThread))!,
            snoozedAt: now,
            snoozedUntil: DateTime.add(now, { days: 1 }),
          },
          DateTime.toEpochMillis(now),
        ),
      );
      yield* settings.updateSettings({ coordinatorReportsEnabled: true });
      assert.equal((yield* store.getThreadShell(reportThread))?.openReportQuestionCount, 1);
      for (const reportShell of [
        (yield* store.getThreadShell(reportThread))!,
        (yield* store.getShellSnapshot()).threads.find((thread) => thread.id === reportThread)!,
      ]) {
        assert.equal(
          DateTime.formatIso(reportShell.latestOpenReportQuestionAt!),
          DateTime.formatIso(now),
        );
        assert.isFalse(isAutoSettlementCandidate(reportShell, DateTime.toEpochMillis(now)));
        for (const [snoozedAt, expected] of [
          [DateTime.add(now, { minutes: 1 }), true],
          [now, true],
          [DateTime.subtract(now, { minutes: 1 }), false],
        ] as const) {
          assert.equal(
            isSnoozed(
              { ...reportShell, snoozedAt, snoozedUntil: DateTime.add(now, { days: 1 }) },
              DateTime.toEpochMillis(now),
            ),
            expected,
          );
        }
      }
      const candidates = yield* store.getSettlementCandidates();
      assert.isFalse(candidates.some((thread) => thread.id === reportThread));
      const shell = yield* store.getShellSnapshot({ location: "active" });
      const eligible = candidates.filter((thread) =>
        isAutoSettlementCandidate(thread, DateTime.toEpochMillis(now)),
      );
      assert.deepEqual(
        new Set(eligible.map((thread) => thread.id)),
        new Set([idle, completed, queued, woke, background, persistent, rolledBack]),
      );
      assert.deepEqual(
        new Set(eligible.map((thread) => thread.id)),
        new Set(
          shell.threads
            .filter((thread) => isAutoSettlementCandidate(thread, DateTime.toEpochMillis(now)))
            .map((thread) => thread.id),
        ),
      );
      for (const candidate of candidates) {
        const expected = shell.threads.find((thread) => thread.id === candidate.id)!;
        assert.deepEqual(candidate.pendingBackgroundTasks, expected.pendingBackgroundTasks);
        const settings = {
          pullRequest: null,
          nowMs: DateTime.toEpochMillis(now),
          autoSettleAfterDays: 7,
          autoSettleOnMerge: false,
        };
        assert.deepEqual(
          resolveAutoSettlementAt({ ...settings, thread: candidate }),
          resolveAutoSettlementAt({
            ...settings,
            thread: {
              ...expected,
              latestUserAuthoredMessageAt: candidate.latestUserAuthoredMessageAt,
            },
          }),
        );
      }
      const originalReport = (yield* store.getThreadProjection(reportThread)).messages.find(
        (message) => message.report,
      )!;
      const snoozedAt = DateTime.add(now, { minutes: 1 });
      const later = DateTime.add(now, { minutes: 2 });
      const checkQuestion = Effect.fn(function* (
        expectedAt: DateTime.Utc | null,
        snoozed: boolean,
      ) {
        const projection = yield* store.getThreadProjection(reportThread);
        for (const reportShell of [
          ProjectionStore.threadShellFromProjection(projection),
          (yield* store.getThreadShell(reportThread))!,
          (yield* store.getShellSnapshot()).threads.find((thread) => thread.id === reportThread)!,
        ]) {
          assert.equal(reportShell.openReportQuestionCount, expectedAt === null ? 0 : 1);
          assert.equal(
            reportShell.latestOpenReportQuestionAt == null
              ? null
              : DateTime.formatIso(reportShell.latestOpenReportQuestionAt),
            expectedAt === null ? null : DateTime.formatIso(expectedAt),
          );
          assert.equal(
            isSnoozed(
              { ...reportShell, snoozedAt, snoozedUntil: DateTime.add(now, { days: 1 }) },
              DateTime.toEpochMillis(later),
            ),
            snoozed,
          );
        }
      });
      yield* checkQuestion(now, true);
      yield* store.apply({
        id: EventId.make("event:report:unchanged"),
        type: "message.updated",
        threadId: reportThread,
        occurredAt: later,
        payload: { ...originalReport, updatedAt: later },
      });
      yield* checkQuestion(now, true);
      yield* store.apply({
        id: EventId.make("event:report:new-question"),
        type: "message.updated",
        threadId: reportThread,
        occurredAt: later,
        payload: {
          ...originalReport,
          id: MessageId.make("report:new-question"),
          report: { ...originalReport.report!, version: 2 },
          createdAt: later,
          updatedAt: later,
        },
      });
      yield* checkQuestion(later, false);
      const { question: _question, answers: _answers, ...withoutQuestion } = originalReport.report!;
      yield* store.apply({
        id: EventId.make("event:report:closed"),
        type: "message.updated",
        threadId: reportThread,
        occurredAt: later,
        payload: {
          ...originalReport,
          id: MessageId.make("report:closed"),
          report: { ...withoutQuestion, version: 3 },
          createdAt: later,
          updatedAt: later,
        },
      });
      yield* checkQuestion(null, true);
      // Two open questions; resolving the newer leaves the older one's time.
      const openReport = (key: string, at: DateTime.Utc, resolved?: { at: string }) =>
        store.apply({
          id: EventId.make(`event:report:${key}:${resolved ? "resolved" : "posted"}`),
          type: "message.updated",
          threadId: reportThread,
          occurredAt: at,
          payload: {
            ...originalReport,
            id: MessageId.make(`report:${key}`),
            report: {
              ...originalReport.report!,
              key,
              version: 1,
              ...(resolved ? { resolved } : {}),
            },
            createdAt: at,
            updatedAt: at,
          },
        });
      yield* openReport("older", now);
      yield* openReport("newer", later);
      assert.equal((yield* store.getThreadShell(reportThread))?.openReportQuestionCount, 2);
      yield* openReport("newer", later, { at: DateTime.formatIso(later) });
      yield* checkQuestion(now, true);
      assert.equal(
        DateTime.formatIso((yield* store.getThread(completed)).createdAt),
        DateTime.formatIso(old),
      );
      assert.equal(
        (yield* store.getThread(ThreadId.make("missing")).pipe(Effect.flip))._tag,
        "ProjectionStoreThreadNotFoundError",
      );
    }).pipe(
      Effect.provide(
        layerSql.pipe(
          Layer.provideMerge(ServerSettings.layerTest({ coordinatorReportsEnabled: true })),
        ),
      ),
    ),
);

it.effect("sql: a store without server settings counts no open report questions", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const now = DateTime.makeUnsafe("2026-11-17T00:00:00.000Z");
    const threadId = yield* createThread("report-question-no-settings");
    yield* createRun(threadId);
    yield* store.apply({
      id: EventId.make("event:no-settings:report"),
      type: "message.updated",
      threadId,
      occurredAt: now,
      payload: {
        createdBy: "agent",
        creationSource: "mcp",
        id: MessageId.make("message:no-settings:report"),
        threadId,
        runId: null,
        nodeId: null,
        role: "assistant",
        text: "Choose a release",
        report: { key: "release", version: 1, title: "Release", question: "Ship?" },
        attachments: [],
        streaming: false,
        createdAt: now,
        updatedAt: now,
      },
    });
    assert.equal((yield* store.getThreadShell(threadId))?.openReportQuestionCount, 0);
  }).pipe(Effect.provide(layerSql)),
);

it.effect("sql: the user-authored time ignores notifications and scheduled runs", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = yield* createThread("agent-woken");
    yield* createRun(threadId);
    const message = (
      id: string,
      createdBy: "user" | "agent",
      creationSource: "web" | "provider",
      at: DateTime.Utc,
      scheduledTaskId?: ScheduledTaskId,
    ) =>
      store.apply({
        id: EventId.make(`event:settlement:${id}`),
        type: "message.updated",
        threadId,
        occurredAt: at,
        payload: {
          createdBy,
          creationSource,
          id: MessageId.make(`message:settlement:${id}`),
          threadId,
          runId: null,
          nodeId: null,
          role: "user",
          text: id,
          attachments: [],
          streaming: false,
          createdAt: at,
          updatedAt: at,
          ...(scheduledTaskId === undefined ? {} : { scheduledTaskId }),
        },
      });
    const written = DateTime.subtract(now, { hours: 2 });
    yield* message("written", "user", "web", written);
    // A task the user made sends its runs as the user.
    yield* message(
      "scheduled",
      "user",
      "web",
      DateTime.subtract(now, { hours: 1 }),
      ScheduledTaskId.make("scheduled-task:settlement"),
    );
    yield* message("notification", "agent", "provider", now);

    const [candidate] = yield* store.getSettlementCandidates(threadId);
    assert.isDefined(candidate);
    assert.equal(DateTime.formatIso(candidate.latestUserMessageAt!), DateTime.formatIso(now));
    assert.equal(
      DateTime.formatIso(candidate.latestUserAuthoredMessageAt!),
      DateTime.formatIso(written),
    );
    for (const shell of [
      (yield* store.getShellSnapshot()).threads.find((thread) => thread.id === threadId)!,
      ProjectionStore.threadShellFromProjection(yield* store.getThreadProjection(threadId)),
    ]) {
      assert.equal(
        DateTime.formatIso(shell.latestUserAuthoredMessageAt!),
        DateTime.formatIso(written),
      );
    }
  }).pipe(Effect.provide(layerSql)),
);

const pullRequestLink = (number: number) => ({
  host: "github.com",
  repository: "owner/repository",
  number,
  url: `https://github.com/owner/repository/pull/${number}`,
  source: "manual" as const,
  linkedAt: DateTime.formatIso(old),
  snapshot: null,
  stack: null,
});

it.effect("sql: lists only active threads with pull request links, oldest first", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    yield* createThread("no-links");
    yield* createThread("empty-links", { pullRequests: [] });
    yield* createThread("archived-link", {
      archivedAt: old,
      pullRequests: [pullRequestLink(1)],
    });
    const settled = yield* createThread("settled-link", {
      settledOverride: "settled",
      settledAt: old,
      updatedAt: DateTime.subtract(now, { days: 12 }),
      pullRequests: [pullRequestLink(2)],
    });
    const open = yield* createThread("open-link", {
      pullRequests: [pullRequestLink(3), pullRequestLink(4)],
    });

    const threads = yield* store.getThreadsWithPullRequests();
    assert.deepEqual(
      threads.map((thread) => [thread.id, thread.settledOverride, thread.pullRequests?.length]),
      [
        [settled, "settled", 1],
        [open, null, 2],
      ],
    );
    assert.deepEqual(
      (yield* store.getThreadsWithPullRequests(open)).map((thread) => thread.id),
      [open],
    );
  }).pipe(Effect.provide(layerSql)),
);

it.effect("sql: an unsettled-only shell read skips settled threads", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const open = yield* createThread("unsettled-open");
    const reopened = yield* createThread("unsettled-reopened", { settledOverride: "active" });
    yield* createThread("unsettled-manual", { settledOverride: "settled", settledAt: old });
    yield* createThread("unsettled-auto", { settledAt: old });
    yield* createThread("unsettled-archived", { archivedAt: old });

    const shell = yield* store.getShellSnapshot({ location: "active", unsettledOnly: true });
    assert.deepEqual(new Set(shell.threads.map((thread) => thread.id)), new Set([open, reopened]));
    assert.equal(shell.archivedThreads.length, 0);
    const all = yield* store.getShellSnapshot({ location: "active" });
    assert.equal(all.threads.length, 4);
  }).pipe(Effect.provide(layerSql)),
);

it.effect("sql: a busy-only shell read keeps every thread with work in flight", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    yield* createThread("quiet-idle");
    yield* createRun(yield* createThread("quiet-completed"));
    yield* createRun(yield* createThread("quiet-queued"), "queued");
    yield* createRun(yield* createThread("quiet-archived", { archivedAt: old }), "running");
    const settledItem = yield* createThread("quiet-settled-item");
    yield* createItem(settledItem, yield* createRun(settledItem), "completed");
    const pullRequest = {
      host: "github.com",
      repository: "example/repo",
      number: 7,
      url: "https://github.com/example/repo/pull/7",
      source: "agent" as const,
      linkedAt: DateTime.formatIso(old),
      snapshot: null,
      stack: null,
    };
    yield* createThread("quiet-unwatched-pr", { pullRequests: [pullRequest] });

    const busy = new Set<ThreadId>();
    for (const status of ["preparing", "starting", "running", "waiting"] as const) {
      const threadId = yield* createThread(`busy-${status}`);
      yield* createRun(threadId, "completed");
      yield* createRun(threadId, status, 2);
      busy.add(threadId);
    }
    // A newer finished run hides the older running one from status; only activityRunStatus shows it.
    const olderRunning = yield* createThread("busy-older-running");
    yield* createRun(olderRunning, "running");
    yield* createRun(olderRunning, "completed", 2);
    busy.add(olderRunning);
    const requested = yield* createThread("busy-request");
    yield* createRun(requested);
    yield* store.apply({
      id: EventId.make("event:busy:request"),
      type: "runtime-request.updated",
      threadId: requested,
      occurredAt: old,
      payload: {
        id: RuntimeRequestId.make("request:busy"),
        nodeId: NodeId.make("node:busy"),
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "not_resumable", reason: "Process stopped" },
        createdAt: old,
        resolvedAt: null,
      },
    });
    busy.add(requested);
    const background = yield* createThread("busy-background-item");
    yield* createItem(background, yield* createRun(background), "running");
    busy.add(background);
    const roster = yield* createThread("busy-provider-roster");
    yield* createRun(roster);
    yield* store.apply({
      id: EventId.make("event:busy:roster"),
      type: "provider-thread.updated",
      threadId: roster,
      occurredAt: old,
      payload: {
        id: ProviderThreadId.make("provider-thread:busy"),
        appThreadId: roster,
        ownerNodeId: null,
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId,
        providerSessionId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        createdAt: old,
        updatedAt: old,
        pendingBackgroundTasks: [{ taskId: "running-task", kind: "subagent" }],
      },
    });
    busy.add(roster);
    busy.add(
      yield* createThread("busy-watched-pr", {
        pullRequests: [
          {
            ...pullRequest,
            watch: {
              startedAt: DateTime.formatIso(old),
              headSha: null,
              failedChecks: [],
              passed: false,
              passedChecks: [],
              remarksThrough: DateTime.formatIso(old),
              remarkIds: [],
              conflicting: false,
              wakes: 0,
            },
          },
        ],
      }),
    );
    busy.add(
      yield* createThread("busy-workflow-run", {
        workflowRuns: [
          {
            host: "github.com",
            repository: "example/repo",
            runId: 812,
            url: "https://github.com/example/repo/actions/runs/812",
            name: "CI #812",
            startedAt: DateTime.formatIso(old),
          },
        ],
      }),
    );

    const all = yield* store.getShellSnapshot({ location: "active" });
    const hidden = all.threads.find((thread) => thread.id === olderRunning);
    assert.equal(hidden?.status, "completed");
    assert.equal(hidden?.activityRunStatus, "running");
    const expected = all.threads.filter(
      (thread) =>
        thread.status === "preparing" ||
        thread.status === "starting" ||
        thread.status === "running" ||
        thread.status === "waiting" ||
        (thread.activityRunStatus ?? null) !== null ||
        thread.pendingRuntimeRequest !== null ||
        (thread.pendingBackgroundTasks?.length ?? 0) > 0,
    );
    assert.deepEqual(new Set(expected.map((thread) => thread.id)), busy);
    const narrowed = yield* store.getShellSnapshot({ location: "active", busyOnly: true });
    assert.deepEqual(narrowed.threads, expected);
    assert.equal(narrowed.archivedThreads.length, 0);
  }).pipe(Effect.provide(layerSql)),
);

it.effect("sql: a subagent thread becomes a candidate once its parent is done", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const parent = yield* createThread("subagent-parent");
    const child = yield* createThread("subagent-child", {
      lineage: { parentThreadId: parent, relationshipToParent: "subagent", rootThreadId: parent },
    });
    const ids = () =>
      store.getSettlementCandidates().pipe(Effect.map((rows) => rows.map((row) => row.id)));
    assert.deepEqual(yield* ids(), [parent]);

    const parentThread = yield* store.getThread(parent);
    for (const [type, overrides] of [
      ["thread.settled", { settledOverride: "settled", settledAt: now }],
      ["thread.archived", { archivedAt: now }],
      ["thread.deleted", { deletedAt: now }],
    ] satisfies ReadonlyArray<
      readonly [
        "thread.settled" | "thread.archived" | "thread.deleted",
        Partial<OrchestrationV2AppThread>,
      ]
    >) {
      yield* store.apply({
        id: EventId.make(`event:settlement:subagent-parent:${type}`),
        type,
        threadId: parent,
        occurredAt: now,
        payload: { ...parentThread, ...overrides, updatedAt: now },
      });
      assert.deepEqual(yield* ids(), [child]);
    }
    const orphan = yield* createThread("orphan", {
      lineage: {
        parentThreadId: ThreadId.make("missing-parent"),
        relationshipToParent: "subagent",
        rootThreadId: parent,
      },
    });
    assert.deepEqual(new Set(yield* ids()), new Set([child, orphan]));
  }).pipe(Effect.provide(layerSql)),
);
