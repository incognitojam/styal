import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { threadHoldsWorktree } from "../orchestration-v2/ThreadSettlementService.ts";
import { WorkspacePortHolders, WorkspacePortHoldersError } from "./WorkspacePortAllocator.ts";

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const path = yield* Path.Path;

  const snapshot = Effect.gen(function* () {
    const projectRoots = new Map(
      (yield* projects.list({ includeDeleted: true })).map((project) => [
        project.projectId as string,
        project.workspaceRoot,
      ]),
    );
    // A thread without a worktree works in its project's checkout, as RuntimePolicy resolves it.
    const workspaceOf = (projectId: string, worktreePath: string | null) => {
      const workspace = worktreePath ?? projectRoots.get(projectId);
      return workspace === undefined ? null : path.resolve(workspace);
    };

    // Deleted and archived threads count for ordering: they say when the folder was last used.
    const activity = yield* sql<{
      readonly projectId: string;
      readonly worktreePath: string | null;
      readonly lastActivityAt: string;
    }>`
      SELECT
        project_id AS "projectId",
        json_extract(payload_json, '$.worktreePath') AS "worktreePath",
        MAX(updated_at) AS "lastActivityAt"
      FROM orchestration_v2_projection_threads
      GROUP BY project_id, json_extract(payload_json, '$.worktreePath')
    `;
    const lastActivityMs = new Map<string, number>();
    for (const row of activity) {
      const workspace = workspaceOf(row.projectId, row.worktreePath);
      const at = Date.parse(row.lastActivityAt);
      if (workspace === null || Number.isNaN(at)) continue;
      lastActivityMs.set(workspace, Math.max(at, lastActivityMs.get(workspace) ?? at));
    }

    // Every thread threadHoldsWorktree can count is unsettled or busy, so these two
    // smaller reads stand in for the full shell snapshot.
    const [unsettled, busy] = yield* Effect.all([
      projections.getShellSnapshot({ location: "active", unsettledOnly: true }),
      projections.getShellSnapshot({ location: "active", busyOnly: true }),
    ]);
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const openPaths = new Set<string>();
    const addThread = (thread: OrchestrationV2ThreadShell) => {
      const workspace = workspaceOf(thread.projectId, thread.worktreePath);
      if (workspace !== null) openPaths.add(workspace);
    };
    for (const thread of [...unsettled.threads, ...busy.threads]) {
      if (threadHoldsWorktree(thread, nowMs)) addThread(thread);
    }
    return { openPaths, lastActivityMs };
  }).pipe(
    Effect.mapError((cause) => new WorkspacePortHoldersError({ cause })),
    Effect.withSpan("WorkspacePortHolders.snapshot"),
  );

  return WorkspacePortHolders.of({ snapshot });
});

export const layer = Layer.effect(WorkspacePortHolders, make);
