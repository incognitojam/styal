import {
  ProviderSessionId,
  WorktreeCleanupError,
  type OrchestrationV2ThreadShell,
  type ServerSettings,
  type StorageCleanupReportEntry,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
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

export class CheckoutSweepLimits extends Context.Reference<{
  readonly durationMs: number;
  readonly roots: number;
}>("worktreeCleanup/CheckoutSweepLimits", {
  defaultValue: () => ({ durationMs: 600_000, roots: 10_000 }),
}) {}

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
  const limits = yield* CheckoutSweepLimits;
  const platform = yield* HostProcess.Platform;
  const sql = yield* SqlClient.SqlClient;
  const inactivity = (
    threads: readonly OrchestrationV2ThreadShell[],
    byId: ReadonlyMap<OrchestrationV2ThreadShell["id"], OrchestrationV2ThreadShell>,
    saved: ServerSettings,
    now: number,
  ) => {
    if (
      !threads.length ||
      !threads.every(
        (thread) =>
          saved.projectSettingsOverrides[thread.projectId]?.releaseWorktreeSources === true,
      )
    )
      return "Source cleanup is disabled";
    for (const thread of threads) {
      const chain = worktreeSettlementChain(thread, byId, now, saved);
      const at = chain.at(-1)?.settledAt ?? thread.archivedAt;
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
      )
        return "Thread or its parent is active, has pending work, or has not been settled for 7 days";
    }
    return null;
  };
  return Effect.fn("WorktreeCleanup.sweepCheckouts")(function* (
    hasTerminal: (root: string) => boolean,
    report: StorageCleanupReportEntry[],
    hasCanonicalTerminal: (root: string) => Effect.Effect<boolean, PlatformError>,
  ) {
    if (platform === "win32") return;
    const saved = yield* settings.getSettings;
    if (
      !Object.values(saved.projectSettingsOverrides).some(
        (entry) => entry.releaseWorktreeSources === true,
      )
    )
      return;
    const deadline = (yield* Clock.currentTimeMillis) + limits.durationMs;
    const budget = Effect.gen(function* () {
      if ((yield* Clock.currentTimeMillis) >= deadline)
        return yield* new WorktreeCleanupError({
          reason: "run-failed",
          message: "Source checkout sweep exceeded its time budget; files kept",
        });
    });
    const initial = yield* projections.getShellSnapshot();
    const initialThreads = [...initial.threads, ...initial.archivedThreads].filter(
      (thread) => thread.deletedAt === null,
    );
    const byId = new Map(initialThreads.map((thread) => [thread.id, thread]));
    const groups = Map.groupBy(
      initialThreads.filter((thread) => thread.worktreePath !== null),
      (thread) => thread.worktreePath!,
    );
    const initialProjects = yield* projects.listShells();
    const locations = new Map<string, string | null>();
    const canonical = Effect.fn("WorktreeCleanup.checkoutCanonicalPath")(function* (
      target: string,
    ) {
      yield* budget;
      const cached = locations.get(target);
      // Canonical paths and absent folders are stable within a sweep; aliases are resolved again under the lease.
      if (cached !== undefined && (cached === target || cached === null)) return cached;
      const real = yield* fs.realPath(target).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed(null),
        ),
      );
      locations.set(target, real);
      return real;
    });
    let inspected = 0;
    for (const [root, owners] of groups) {
      const now = yield* Clock.currentTimeMillis;
      if (++inspected > limits.roots || now >= deadline) {
        report.push({
          kind: "worktree-files",
          outcome: "kept",
          reason:
            "Source checkout sweep reached its time or worktree limit; remaining worktrees kept",
          path: null,
          projectPath: null,
          threadId: null,
          threadTitle: null,
          bytes: null,
          files: null,
        });
        break;
      }
      if (
        !owners.every(
          (thread) =>
            saved.projectSettingsOverrides[thread.projectId]?.releaseWorktreeSources === true,
        )
      )
        continue;
      let reason = "Worktree checkout inspection failed; files kept";
      let entry: StorageCleanupReportEntry = {
        kind: "worktree-files",
        outcome: "kept",
        reason,
        path: root,
        projectPath:
          initialProjects.find((project) => project.id === owners[0]!.projectId)?.workspaceRoot ??
          null,
        threadId: owners[0]!.id,
        threadTitle: owners[0]!.title,
        bytes: null,
        files: null,
      };
      const idleReason = inactivity(owners, byId, saved, now);
      const run = Effect.gen(function* () {
        const real = yield* canonical(root);
        if (real === null) return;
        if (!(yield* managed(root)) || path.resolve(root) !== root || real !== root) {
          report.push({ ...entry, reason: "Not a canonical managed worktree" });
          return;
        }
        const eligible = Effect.fn("WorktreeCleanup.checkoutEligible")(function* () {
          yield* budget;
          const saved = yield* settings.getSettings;
          const snapshot = yield* projections.getShellSnapshot();
          const all = [...snapshot.threads, ...snapshot.archivedThreads].filter(
            (thread) => thread.deletedAt === null,
          );
          const threads = all.filter((thread) => thread.worktreePath === root);
          const idleReason = inactivity(
            threads,
            new Map(all.map((thread) => [thread.id, thread])),
            saved,
            yield* Clock.currentTimeMillis,
          );
          if (idleReason) {
            reason = idleReason;
            return null;
          }
          const allProjects = yield* projects.listShells();
          const project = allProjects.find((project) => project.id === threads[0]!.projectId);
          if (!project || threads.some((thread) => thread.projectId !== project.id)) {
            reason = "Worktree has unavailable or different projects";
            return null;
          }
          entry = { ...entry, projectPath: project.workspaceRoot };
          if ((yield* fs.realPath(root)) !== root || !(yield* managed(root))) {
            reason = "Not a canonical managed worktree";
            return null;
          }
          for (const other of allProjects) {
            const declared = path.resolve(other.workspaceRoot);
            if (declared === root || declared.startsWith(`${root}${path.sep}`)) {
              reason = "Folder contains a project root";
              return null;
            }
            const projectRoot = yield* canonical(other.workspaceRoot);
            if (
              projectRoot !== null &&
              (projectRoot === root || projectRoot.startsWith(`${root}${path.sep}`))
            ) {
              reason = "Folder contains a project root";
              return null;
            }
          }
          for (const thread of all) {
            if (!thread.worktreePath || thread.worktreePath === root) continue;
            if ((yield* canonical(thread.worktreePath)) === root) {
              reason = "Another thread uses an aliased spelling of this worktree";
              return null;
            }
          }
          if (
            hasTerminal(root) ||
            (yield* hasCanonicalTerminal(root).pipe(
              Effect.mapError(
                () =>
                  new WorktreeCleanupError({
                    reason: "run-failed",
                    message: "Could not verify a live terminal location; sources kept",
                  }),
              ),
            ))
          ) {
            reason = "Open terminal";
            return null;
          }
          const rows = yield* sql<{
            id: string;
            cwd: string;
          }>`SELECT json_extract(payload_json, '$.id') AS id, json_extract(payload_json, '$.cwd') AS cwd FROM orchestration_v2_projection_provider_sessions WHERE status != 'stopped'`;
          for (const row of rows) {
            yield* budget;
            if (!(yield* sessions.isLive(ProviderSessionId.make(row.id)))) continue;
            const cwd = yield* fs.realPath(row.cwd);
            if (cwd === root || cwd.startsWith(`${root}${path.sep}`)) {
              reason = "Live provider session";
              return null;
            }
          }
          yield* budget;
          return { project, threads };
        });
        yield* lease(
          root,
          Effect.gen(function* () {
            yield* budget;
            const state = yield* checkout.state(root);
            if (state?.phase === "released") {
              report.push({
                ...entry,
                reason: "Sources remain un-checked-out; restored before use",
                bytes: state.bytes ?? null,
              });
              return;
            }
            if (idleReason) return;
            const current = yield* eligible();
            if (!current || !Equal.equals(current.threads, owners)) {
              report.push({ ...entry, reason });
              return;
            }
            if (state) {
              yield* checkout.restore(root);
              report.push({ ...entry, reason: "Completed interrupted checkout recovery" });
              return;
            }
            const bytes = yield* checkout.release(
              root,
              current.project.workspaceRoot,
              Effect.gen(function* () {
                const final = yield* eligible();
                if (!final || !Equal.equals(current, final))
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
