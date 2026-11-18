import { WorktreeCleanupError, type StorageCleanupReportEntry } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderSessions from "../orchestration-v2/ProviderSessionManager.ts";
import * as Settings from "../serverSettings.ts";
import {
  storageCleanupActivityAt,
  storageCleanupThreadIdle,
  worktreeSettlementChain,
} from "../storageCleanup.ts";
import { makeWorkspaceLease } from "../workspace/workspaceLease.ts";
import { makeIsManagedWorktreePath } from "../worktreesDirectory.ts";
import { makeCheckout } from "./Checkout.ts";

export class CheckoutRetention extends Context.Reference<number>(
  "worktreeCleanup/CheckoutRetention",
  {
    defaultValue: () => 7 * 86_400_000,
  },
) {}

export const makeCheckoutSweep = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const sessions = yield* ProviderSessions.ProviderSessionManagerV2;
  const settings = yield* Settings.ServerSettingsService;
  const lease = yield* makeWorkspaceLease;
  const managed = yield* makeIsManagedWorktreePath;
  const checkout = yield* makeCheckout;
  const retention = yield* CheckoutRetention;
  const platform = yield* HostProcess.Platform;
  const sql = yield* SqlClient.SqlClient;
  return Effect.fn("WorktreeCleanup.sweepCheckouts")(function* (
    hasTerminal: (root: string) => boolean,
    report: StorageCleanupReportEntry[],
  ) {
    if (platform === "win32") return;
    const saved = yield* settings.getSettings;
    if (
      !Object.values(saved.projectSettingsOverrides).some(
        (entry) => entry.releaseWorktreeSources === true,
      )
    )
      return;
    const initial = yield* projections.getShellSnapshot();
    const roots = [
      ...new Set(
        [...initial.threads, ...initial.archivedThreads].flatMap((thread) =>
          thread.worktreePath ? [thread.worktreePath] : [],
        ),
      ),
    ];
    for (const root of roots) {
      let reason = "Worktree checkout inspection failed; files kept";
      let entry: StorageCleanupReportEntry = {
        kind: "worktree-files",
        outcome: "kept",
        reason,
        path: root,
        projectPath: null,
        threadId: null,
        threadTitle: null,
        bytes: null,
        files: null,
      };
      const run = Effect.gen(function* () {
        const eligible = Effect.fn("WorktreeCleanup.checkoutEligible")(function* () {
          const saved = yield* settings.getSettings;
          const snapshot = yield* projections.getShellSnapshot();
          const all = [...snapshot.threads, ...snapshot.archivedThreads];
          const threads = all.filter(
            (thread) => thread.worktreePath === root && thread.deletedAt === null,
          );
          if (
            !threads.length ||
            !threads.every(
              (thread) =>
                saved.projectSettingsOverrides[thread.projectId]?.releaseWorktreeSources === true,
            )
          )
            return null;
          const project = (yield* projects.listShells()).find(
            (project) => project.id === threads[0]!.projectId,
          );
          if (!project || threads.some((thread) => thread.projectId !== project.id)) {
            reason = "Worktree has unavailable or different projects";
            return null;
          }
          entry = {
            ...entry,
            projectPath: project.workspaceRoot,
            threadId: threads[0]!.id,
            threadTitle: threads[0]!.title,
          };
          if (
            !(yield* managed(root)) ||
            path.resolve(root) !== root ||
            (yield* fs.realPath(root)) !== root
          ) {
            reason = "Not a canonical managed worktree";
            return null;
          }
          for (const other of yield* projects.listShells()) {
            const projectRoot = yield* fs.realPath(other.workspaceRoot);
            if (projectRoot === root || projectRoot.startsWith(`${root}${path.sep}`)) {
              reason = "Folder contains a project root";
              return null;
            }
          }
          for (const thread of all) {
            if (!thread.worktreePath || thread.deletedAt !== null || thread.worktreePath === root)
              continue;
            const canonical = yield* fs.realPath(thread.worktreePath).pipe(
              Effect.catchIf(
                (error) => error.reason._tag === "NotFound",
                () => Effect.succeed(null),
              ),
            );
            if (canonical === root) {
              reason = "Another thread uses an aliased spelling of this worktree";
              return null;
            }
          }
          const now = yield* Clock.currentTimeMillis;
          const byId = new Map(all.map((thread) => [thread.id, thread]));
          for (const thread of threads) {
            const chain = worktreeSettlementChain(thread, byId, now, saved);
            const settled = chain.at(-1);
            const at = settled?.settledAt ?? thread.archivedAt;
            if (
              !storageCleanupThreadIdle(thread, now, saved) ||
              !at ||
              now -
                Math.max(
                  DateTime.toEpochMillis(at),
                  ...chain.map(storageCleanupActivityAt),
                  storageCleanupActivityAt(thread),
                ) <
                retention
            ) {
              reason =
                "Thread or its parent is active, has pending work, or has not been settled for 7 days";
              return null;
            }
          }
          if (hasTerminal(root)) {
            reason = "Open terminal";
            return null;
          }
          const rows = yield* sql<{
            id: string;
            cwd: string;
          }>`SELECT json_extract(payload_json, '$.id') AS id, json_extract(payload_json, '$.cwd') AS cwd FROM orchestration_v2_projection_provider_sessions WHERE status != 'stopped'`;
          for (const row of rows) {
            if (!(yield* sessions.isLive(row.id as Parameters<typeof sessions.isLive>[0])))
              continue;
            const cwd = yield* fs.realPath(row.cwd);
            if (cwd === root || cwd.startsWith(`${root}${path.sep}`)) {
              reason = "Live provider session";
              return null;
            }
          }
          return { project, threads };
        });
        const before = yield* eligible();
        if (!before) {
          if (entry.threadId) report.push({ ...entry, reason });
          return;
        }
        yield* lease(
          root,
          Effect.gen(function* () {
            const after = yield* eligible();
            if (!after || !Equal.equals(before, after)) {
              report.push({
                ...entry,
                reason: "Worktree ownership or activity changed; files kept",
              });
              return;
            }
            const state = yield* checkout.state(root);
            if (state?.phase === "released") {
              report.push({
                ...entry,
                reason: "Sources remain un-checked-out; restored before use",
                bytes: state.bytes ?? null,
              });
              return;
            }
            if (state) {
              yield* checkout.restore(root);
              report.push({ ...entry, reason: "Completed interrupted checkout recovery" });
              return;
            }
            const bytes = yield* checkout.release(
              root,
              after.project.workspaceRoot,
              Effect.gen(function* () {
                const final = yield* eligible();
                if (!final || !Equal.equals(after, final))
                  return yield* new WorktreeCleanupError({
                    reason: "run-failed",
                    message: "Worktree became active during inspection; files kept",
                  });
              }).pipe(
                Effect.mapError(
                  () =>
                    new WorktreeCleanupError({
                      reason: "run-failed",
                      message: "Worktree eligibility could not be verified; files kept",
                    }),
                ),
              ),
            );
            report.push({
              ...entry,
              outcome: "removed",
              reason:
                "Sources un-checked-out; restored before a turn, terminal, rollback or Git action",
              bytes: bytes ?? 0,
            });
          }),
        );
      });
      yield* run.pipe(
        Effect.catch((error) =>
          Effect.sync(() =>
            report.push({
              ...entry,
              outcome: "failed",
              reason: error._tag === "WorktreeCleanupError" ? error.message : reason,
            }),
          ),
        ),
      );
    }
  });
});
