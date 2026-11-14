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
    const review = yield* approvals.review(input);
    const patterns = review.declared
      .filter((entry) => input.list === "declared" || entry.status === "approved")
      .map((entry) => entry.pattern);
    const approved = new Set(
      review.declared.filter((entry) => entry.status === "approved").map((entry) => entry.pattern),
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
      if (
        path.resolve(worktreePath) === path.resolve(project.value.workspaceRoot) ||
        !(yield* managed(worktreePath))
      ) {
        worktrees.push({ ...entry, status: "kept", reason: "not-managed-worktree" });
        continue;
      }
      const link = yield* fs.readLink(worktreePath).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (link) {
        worktrees.push({ ...entry, status: "kept", reason: "symbolic-link" });
        continue;
      }
      if (!(yield* fs.exists(worktreePath).pipe(Effect.orElseSucceed(() => false)))) {
        worktrees.push({ ...entry, status: "kept", reason: "missing" });
        continue;
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
        worktrees.push({ ...entry, status: "kept", reason: "not-managed-worktree" });
        continue;
      }
      const holding = threads.find((thread) => threadHoldsWorktree(thread, now));
      const selection = yield* select(
        worktreePath,
        patterns,
        review.declared.map((entry) => entry.pattern),
        approved,
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
        ...(holding === undefined
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
    };
  });
  return WorktreeCleanup.of({ preview });
});
export const layer = Layer.effect(WorktreeCleanup, make);
