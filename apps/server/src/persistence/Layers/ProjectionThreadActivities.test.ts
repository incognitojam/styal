import { assert, it } from "@effect/vitest";
import { EventId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

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
});
