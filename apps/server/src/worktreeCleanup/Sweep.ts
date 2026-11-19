import * as Path from "effect/Path";
import * as FileSystem from "effect/FileSystem";
import {
  OrchestrationV2AppThreadJson,
  OrchestrationV2ProviderSessionJson,
  type StorageCleanupReportEntry,
  type ProjectId,
} from "@t3tools/contracts";
import { makeReadPatterns } from "./PatternSource.ts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessions from "../orchestration-v2/ProviderSessionManager.ts";
import { threadHoldsWorktree } from "../orchestration-v2/ThreadSettlementService.ts";
import * as Settings from "../serverSettings.ts";
import { storageCleanupThreadIdle, storageCleanupActivityAt } from "../storageCleanup.ts";
import { makeIsManagedWorktreePath } from "../worktreesDirectory.ts";
import { makeWorkspaceLease } from "../workspace/workspaceLease.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { makeDeletion } from "./Deletion.ts";
import { makeCheckout } from "./Checkout.ts";

const decodeThread = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2AppThreadJson),
);
const decodeSession = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ProviderSessionJson),
);
const day = 86_400_000;

export const makeSweep = Effect.gen(function* () {
  const path = yield* Path.Path;
  const withWorkspaceLease = yield* makeWorkspaceLease;
  const fs = yield* FileSystem.FileSystem;
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* Settings.ServerSettingsService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sessions = yield* ProviderSessions.ProviderSessionManagerV2;
  const managed = yield* makeIsManagedWorktreePath;
  const deletion = yield* makeDeletion;
  const checkout = yield* makeCheckout;
  const readPatterns = yield* makeReadPatterns;
  const checked = new Map<string, string>();
  return Effect.fn("WorktreeCleanup.sweep")(function* (
    hasTerminal: (root: string) => boolean,
    report: StorageCleanupReportEntry[],
  ) {
    const patternCache = new Map<ProjectId, readonly string[]>();
    const deadline = (yield* Clock.currentTimeMillis) + 600_000;
    const snapshot = yield* projections.getShellSnapshot().pipe(NodeSqliteClient.readOnly);
    const spellings = yield* sql<{
      path: string;
    }>`SELECT DISTINCT json_extract(payload_json, '$.worktreePath') AS path FROM orchestration_v2_projection_threads WHERE json_extract(payload_json, '$.worktreePath') IS NOT NULL`.pipe(
      NodeSqliteClient.readOnly,
    );
    const aliasedRoots = new Set<string>();
    for (const entry of spellings) {
      const resolved = path.resolve(entry.path);
      const real = yield* fs.realPath(resolved).pipe(Effect.orElseSucceed(() => resolved));
      if (entry.path !== real) aliasedRoots.add(real);
    }
    const roots = [
      ...new Set(
        [...snapshot.threads, ...snapshot.archivedThreads].flatMap((thread) =>
          thread.worktreePath ? [path.resolve(thread.worktreePath)] : [],
        ),
      ),
    ];
    for (const root of roots) {
      if ((yield* Clock.currentTimeMillis) >= deadline) break;
      const run = Effect.gen(function* () {
        const eligible = Effect.fn("WorktreeCleanup.eligible")(function* () {
          if (!(yield* managed(root)) || hasTerminal(root)) return null;
          if (aliasedRoots.has(root)) return null;
          const allProjects = yield* projects.listShells();
          const unavailableProjects = new Set<string>();
          for (const project of allProjects) {
            const declaredRoot = path.resolve(project.workspaceRoot);
            if (declaredRoot === root || declaredRoot.startsWith(`${root}${path.sep}`)) return null;
            const projectRoot = yield* fs
              .realPath(declaredRoot)
              .pipe(Effect.orElseSucceed(() => null));
            if (projectRoot === null) {
              unavailableProjects.add(project.id);
              continue;
            }
            if (projectRoot === root || projectRoot.startsWith(`${root}${path.sep}`)) return null;
          }
          const rows = yield* sql<{
            payload_json: string;
          }>`SELECT payload_json FROM orchestration_v2_projection_threads WHERE json_extract(payload_json, '$.worktreePath') = ${root}`;
          const decoded = yield* Effect.forEach(rows, (row) => decodeThread(row.payload_json));
          const threads = (yield* Effect.forEach(decoded, (thread) =>
            projections.getThreadShell(thread.id),
          )).filter((thread) => thread !== null);
          if (threads.length === 0) return null;
          const saved = yield* settings.getSettings;
          const now = yield* Clock.currentTimeMillis;
          if (
            threads.some(
              (thread) =>
                threadHoldsWorktree(thread, now) ||
                !storageCleanupThreadIdle(thread, now, saved) ||
                now -
                  Math.max(
                    storageCleanupActivityAt(thread),
                    ...[thread.settledAt, thread.archivedAt].flatMap((value) =>
                      value ? [DateTime.toEpochMillis(value)] : [],
                    ),
                  ) <
                  day,
            )
          )
            return null;
          const project = allProjects.find((project) => project.id === threads[0]!.projectId);
          if (
            !project ||
            unavailableProjects.has(project.id) ||
            threads.some((thread) => thread.projectId !== project.id)
          )
            return null;
          if (
            !saved.regenerableFileCleanupMigrated ||
            saved.projectSettingsOverrides[project.id]?.cleanRegenerableFiles === false
          )
            return null;
          if ((yield* fs.realPath(root)) !== root) return null;
          if ((yield* sql`SELECT 1 FROM worktree_stripped WHERE worktree_path = ${root}`).length)
            return null;
          yield* checkout.verifyOwnership(root, project.workspaceRoot);
          const sessionRows = yield* sql<{
            payload_json: string;
          }>`SELECT payload_json FROM orchestration_v2_projection_provider_sessions WHERE status != 'stopped'`;
          for (const row of sessionRows) {
            const session = yield* decodeSession(row.payload_json);
            const cwd = path.resolve(session.cwd);
            if (
              (cwd === root || cwd.startsWith(`${root}${path.sep}`)) &&
              (yield* sessions.isLive(session.id))
            )
              return null;
          }
          let patterns = patternCache.get(project.id);
          if (patterns === undefined) {
            const source = yield* readPatterns(project.workspaceRoot);
            patterns = source.status === "read" ? source.patterns : [];
            patternCache.set(project.id, patterns);
          }
          if (patterns.length === 0) return null;
          // @effect-diagnostics-next-line globalJsonInEffect:off -- An in-memory comparison key, never decoded or persisted.
          return { project, patterns, stamp: JSON.stringify([threads, patterns]) };
        });
        const initial = yield* eligible();
        if (!initial || checked.get(root) === initial.stamp) return;
        yield* withWorkspaceLease(
          path.resolve(root),
          Effect.gen(function* () {
            const current = yield* eligible();
            if (!current || current.stamp !== initial.stamp) return;
            const selected = yield* deletion.inspect(
              root,
              current.patterns,
              deadline - (yield* Clock.currentTimeMillis),
            );
            checked.set(root, current.stamp);
            if (!selected.length) return;
            const final = yield* eligible();
            if (!final || final.stamp !== current.stamp) return;
            yield* sql`INSERT INTO worktree_stripped (worktree_path, project_id, stripped_at) VALUES (${root}, ${current.project.id}, ${DateTime.formatIso(yield* DateTime.now)})`;
            for (const target of selected) {
              const result = yield* deletion
                .remove(root, target, deadline - (yield* Clock.currentTimeMillis))
                .pipe(Effect.result);
              report.push({
                kind: "worktree-files",
                outcome: result._tag === "Success" ? "removed" : "failed",
                reason:
                  result._tag === "Success"
                    ? "Deleted regenerable path; setup runs on the next turn"
                    : "Could not delete regenerable path",
                path: target,
                projectPath: current.project.workspaceRoot,
                threadId: null,
                threadTitle: null,
                bytes: result._tag === "Success" ? result.success : null,
                files: 1,
              });
            }
          }).pipe(Effect.uninterruptible),
        );
      });
      yield* run.pipe(
        Effect.catch(() =>
          Effect.logWarning("Regenerable file cleanup kept an unverifiable worktree"),
        ),
      );
      yield* Effect.yieldNow;
    }
  });
});
