import { assert, it } from "@effect/vitest";
import { EventId, RuntimeTaskId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionThreadActivityRepository } from "../Services/ProjectionThreadActivities.ts";
import { ProjectionThreadActivityRepositoryLive } from "./ProjectionThreadActivities.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionThreadActivityRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionThreadActivityRepository", (it) => {
  it.effect("lists requested and started setup lifecycle rows without a persisted outcome", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadActivityRepository;
      const threadId = ThreadId.make("thread-setup-recovery");
      const payload = {
        runId: "run-1",
        scriptId: "setup",
        scriptName: "Setup",
        command: "bun install",
        terminalId: "setup-setup",
        worktreePath: "/repo/worktree",
      };
      const append = (id: string, kind: string, sequence: number) =>
        repository.upsert({
          activityId: EventId.make(id),
          threadId,
          turnId: null,
          tone: "info",
          kind,
          summary: kind,
          payload,
          sequence,
          createdAt: `2026-01-01T00:00:0${sequence}.000Z`,
        });

      yield* append("requested", "setup-script.requested", 1);
      yield* append("started", "setup-script.started", 2);
      yield* append("unrelated", "file-edit", 3);
      yield* append("completed", "setup-script.completed", 4);
      yield* repository.upsert({
        activityId: EventId.make("unfinished-requested"),
        threadId,
        turnId: null,
        tone: "info",
        kind: "setup-script.requested",
        summary: "setup-script.requested",
        payload: { ...payload, runId: "run-2" },
        sequence: 5,
        createdAt: "2026-01-01T00:00:05.000Z",
      });
      yield* repository.upsert({
        activityId: EventId.make("unfinished-requested-before-start"),
        threadId,
        turnId: null,
        tone: "info",
        kind: "setup-script.requested",
        summary: "setup-script.requested",
        payload: { ...payload, runId: "run-3" },
        sequence: 6,
        createdAt: "2026-01-01T00:00:06.000Z",
      });
      yield* repository.upsert({
        activityId: EventId.make("unfinished-started"),
        threadId,
        turnId: null,
        tone: "info",
        kind: "setup-script.started",
        summary: "setup-script.started",
        payload: { ...payload, runId: "run-3" },
        sequence: 7,
        createdAt: "2026-01-01T00:00:07.000Z",
      });

      const rows = yield* repository.listUnfinishedSetupRuns();
      assert.deepEqual(
        rows.map((row) => row.activityId),
        [
          EventId.make("unfinished-requested"),
          EventId.make("unfinished-requested-before-start"),
          EventId.make("unfinished-started"),
        ],
      );
    }),
  );

  it.effect("finds task lifecycle rows outside the thread-detail activity window", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadActivityRepository;
      const threadId = ThreadId.make("thread-task-recovery");
      const taskId = RuntimeTaskId.make("quiet-background-task");
      yield* repository.upsert({
        activityId: EventId.make("quiet-task-started"),
        threadId,
        turnId: null,
        tone: "info",
        kind: "task.started",
        summary: "local_bash task started",
        payload: { taskId, taskType: "local_bash", agentKind: "background" },
        sequence: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      yield* Effect.forEach(
        Array.from({ length: 501 }, (_, index) => index),
        (index) =>
          repository.upsert({
            activityId: EventId.make(`unrelated-task-${index}`),
            threadId,
            turnId: null,
            tone: "info",
            kind: "task.updated",
            summary: "Unrelated task updated",
            payload: { taskId: `unrelated-${index}`, status: "running" },
            sequence: index + 2,
            createdAt: "2026-01-01T00:00:01.000Z",
          }),
        { concurrency: 16 },
      );

      const rows = yield* repository.listTaskLifecycleByTaskId({ threadId, taskId });
      assert.deepEqual(
        rows.map((row) => row.activityId),
        [EventId.make("quiet-task-started")],
      );
    }),
  );

  it.effect("reads only the latest matching task activity", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadActivityRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-latest-task-activity");

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        )
        VALUES
          (
            'activity-task-unrelated-tool', ${threadId}, NULL, 'tool', 'tool.completed',
            'large tool output', 'not-json', 1, '2026-03-01T00:00:00.000Z'
          ),
          (
            'activity-task-started', ${threadId}, NULL, 'info', 'task.started',
            'started', '{"taskId":"task-1","title":"Initial title"}', 2,
            '2026-03-01T00:00:01.000Z'
          ),
          (
            'activity-task-progress', ${threadId}, NULL, 'info', 'task.progress',
            'progress', '{"taskId":"task-1","title":"Updated title"}', 3,
            '2026-03-01T00:00:02.000Z'
          ),
          (
            'activity-task-other', ${threadId}, NULL, 'info', 'task.progress',
            'other', '{"taskId":"task-2","title":"Other title"}', 4,
            '2026-03-01T00:00:03.000Z'
          )
      `;

      yield* repository.upsert({
        activityId: EventId.make("activity-task-untitled"),
        threadId,
        turnId: null,
        tone: "info",
        kind: "task.progress",
        summary: "Still running",
        payload: { taskId: "task-1" },
        sequence: 5,
        createdAt: "2026-03-01T00:00:04.000Z",
      });
      yield* repository.upsert({
        activityId: EventId.make("activity-task-blank-title"),
        threadId,
        turnId: null,
        tone: "info",
        kind: "task.progress",
        summary: "Still running",
        payload: { taskId: "task-1", title: " \t\n\u00a0" },
        sequence: 6,
        createdAt: "2026-03-01T00:00:05.000Z",
      });

      const recent = yield* repository.listByThreadId({
        threadId,
        activityKinds: ["task.progress"],
        limit: 2,
      });
      assert.deepEqual(
        recent.map((entry) => entry.activityId),
        ["activity-task-untitled", "activity-task-blank-title"],
      );

      const activity = yield* repository.getLatestTaskActivity({
        threadId,
        taskId: "task-1",
      });
      assert.equal(activity._tag, "Some");
      if (activity._tag === "Some") {
        assert.equal(activity.value.activityId, EventId.make("activity-task-progress"));
        assert.deepEqual(activity.value.payload, {
          taskId: "task-1",
          title: "Updated title",
        });
      }

      assert.equal(
        (yield* repository.getLatestTaskActivity({ threadId, taskId: "missing" }))._tag,
        "None",
      );
    }),
  );
});
