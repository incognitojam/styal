import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import {
  WorktreeCleanupError,
  type WorktreeCleanupPreview,
  type WorktreeCleanupPreviewEntry,
  type WorktreeCleanupPreviewInput,
} from "@t3tools/contracts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { threadHoldsWorktree } from "../orchestration-v2/ThreadSettlementService.ts";
import { makeIsManagedWorktreePath } from "../worktreesDirectory.ts";
import { makeInspectGit } from "./gitInspection.ts";
import * as Approvals from "./Approvals.ts";
import { makeSelect } from "./Selection.ts";

export class WorktreeCleanup extends Context.Service<
  WorktreeCleanup,
  {
    readonly preview: (
      input: WorktreeCleanupPreviewInput,
    ) => Effect.Effect<WorktreeCleanupPreview, WorktreeCleanupError>;
  }
>()("@styal/cli/worktreeCleanup/WorktreeCleanup") {}

const make = Effect.gen(function* () {
  const approvals = yield* Approvals.Approvals;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectService.ProjectService;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const inspectGit = yield* makeInspectGit;
  const managed = yield* makeIsManagedWorktreePath;
  const select = yield* makeSelect;
  const preview = Effect.fn("WorktreeCleanup.preview")(function* (
    input: WorktreeCleanupPreviewInput,
  ) {
    const deadline = (yield* Clock.currentTimeMillis) + 30_000;
    const budget = Effect.fn("WorktreeCleanup.budget")(function* <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) {
      const remaining = deadline - (yield* Clock.currentTimeMillis);
      if (remaining <= 0) return Option.none<A>();
      return yield* effect.pipe(Effect.timeoutOption(remaining));
    });
    const prepare = Effect.gen(function* () {
      const review = yield* approvals.review(input);
      const patterns = review.declared
        .filter((entry) => input.list === "declared" || entry.status === "approved")
        .map((entry) => entry.pattern);
      const approved = new Set(
        review.declared
          .filter((entry) => entry.status === "approved")
          .map((entry) => entry.pattern),
      );
      const project = yield* projects.getById(input.projectId).pipe(Effect.orDie);
      if (Option.isNone(project))
        return yield* new WorktreeCleanupError({
          reason: "project-not-found",
          message: "Project not found.",
        });
      const snapshot = yield* projections.getShellSnapshot().pipe(Effect.orDie);
      const groups = new Map<string, (typeof snapshot.threads)[number][]>();
      for (const thread of [...snapshot.threads, ...snapshot.archivedThreads]) {
        if (
          thread.projectId !== input.projectId ||
          thread.deletedAt !== null ||
          thread.worktreePath === null
        )
          continue;
        const group = groups.get(thread.worktreePath) ?? [];
        group.push(thread);
        groups.set(thread.worktreePath, group);
      }
      return { review, patterns, approved, project: project.value, groups };
    });
    const prepared = yield* budget(prepare);
    if (Option.isNone(prepared))
      return yield* new WorktreeCleanupError({
        reason: "run-failed",
        message: "Preview deadline reached before project metadata was available.",
      });
    const { review, patterns, approved, project, groups } = prepared.value;
    const worktrees: WorktreeCleanupPreviewEntry[] = [];
    const now = yield* Clock.currentTimeMillis;
    for (const [worktreePath, threads] of [...groups].slice(0, 200)) {
      const entry: WorktreeCleanupPreviewEntry = {
        worktreePath,
        threadCount: threads.length,
        status: "eligible",
        selected: [],
        kept: [],
        freedBytes: null,
        entriesTruncated: false,
        measurementComplete: false,
      };
      const metadata = yield* budget(
        Effect.gen(function* () {
          if (
            path.resolve(worktreePath) === path.resolve(project.workspaceRoot) ||
            !(yield* managed(worktreePath))
          ) {
            return { ...entry, status: "kept" as const, reason: "not-managed-worktree" as const };
          }
          const link = yield* fs.readLink(worktreePath).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
          if (link) {
            return { ...entry, status: "kept" as const, reason: "symbolic-link" as const };
          }
          if (!(yield* fs.exists(worktreePath).pipe(Effect.orElseSucceed(() => false)))) {
            return { ...entry, status: "kept" as const, reason: "missing" as const };
          }
          const probe = yield* inspectGit(worktreePath, [
            "rev-parse",
            "--show-toplevel",
            "--git-common-dir",
            "--git-dir",
          ]).pipe(Effect.option);
          const lines = Option.isSome(probe) ? probe.value.stdout.trim().split("\n") : [];
          if (
            lines.length !== 3 ||
            path.resolve(lines[0]!) !== worktreePath ||
            path.resolve(worktreePath, lines[1]!) === path.resolve(worktreePath, lines[2]!)
          ) {
            return { ...entry, status: "kept" as const, reason: "not-managed-worktree" as const };
          }
          return null;
        }),
      );
      if (Option.isNone(metadata)) {
        worktrees.push({ ...entry, status: "kept", reason: "not-checked", entriesTruncated: true });
        continue;
      }
      if (metadata.value !== null) {
        worktrees.push(metadata.value);
        continue;
      }
      const holding = threads.find((thread) => threadHoldsWorktree(thread, now));
      const selection = yield* select(
        worktreePath,
        patterns,
        review.declared.map((entry) => entry.pattern),
        approved,
        deadline,
      ).pipe(
        Effect.mapError(
          () =>
            new WorktreeCleanupError({
              reason: "run-failed",
              message: "Could not inspect worktree cleanup candidates.",
            }),
        ),
      );
      worktrees.push({
        ...entry,
        ...selection,
        ...((yield* Clock.currentTimeMillis) >= deadline
          ? { status: "kept" as const, reason: "not-checked" as const }
          : {}),
        ...((yield* Clock.currentTimeMillis) >= deadline || holding === undefined
          ? {}
          : {
              status: "kept",
              reason: "unsettled-thread",
              holdingThread: { id: holding.id, title: holding.title },
            }),
      });
    }
    return {
      review,
      patterns,
      worktrees,
      worktreesTruncated: groups.size > 200,
      deadlineReached: (yield* Clock.currentTimeMillis) >= deadline,
    };
  });
  return WorktreeCleanup.of({ preview });
});
export const layer = Layer.effect(WorktreeCleanup, make);
