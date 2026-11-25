import { ThreadId, type ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { makeIsManagedWorktreePath } from "../worktreesDirectory.ts";
import { WorktreeGitDataMissingError } from "./gitCeiling.ts";
import { isWithinRoot } from "./KnownWorkspaces.ts";
import { TerminalLaunchPreparation } from "../terminal/Manager.ts";

class WorktreeRecreateError extends Schema.TaggedError<WorktreeRecreateError>()(
  "WorktreeRecreateError",
  {
    worktreePath: Schema.String,
    branch: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not recreate the worktree for branch '${this.branch}' at ${this.worktreePath}.`;
  }
}

class WorktreeRecreateNoBaseError extends Schema.TaggedError<WorktreeRecreateNoBaseError>()(
  "WorktreeRecreateNoBaseError",
  { worktreePath: Schema.String, branch: Schema.String },
) {
  override get message(): string {
    return `Could not recreate branch '${this.branch}' at ${this.worktreePath}: the project workspace has no commit to start it from.`;
  }
}

interface WorktreeThread {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly worktreePath: string | null;
  readonly branch: string | null;
}

export const makeRestoreMissingWorktree = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const projects = yield* ProjectService.ProjectService;
  const setupScripts = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const isManagedWorktreePath = yield* makeIsManagedWorktreePath;

  const resolveRecreateBase = Effect.fn("restoreMissingWorktree.resolveRecreateBase")(function* (
    cwd: string,
  ) {
    // Recovery can follow an external checkout, before the status cache expires.
    yield* gitWorkflow.invalidateLocalStatus(cwd);
    const { refName: currentBranch } = yield* gitWorkflow.localStatus({ cwd });
    if (currentBranch !== null) {
      const refName = `refs/heads/${currentBranch}`;
      return { refName, baseRefName: refName };
    }
    if (yield* gitWorkflow.hasCommit({ cwd, refName: "refs/remotes/origin/HEAD" })) {
      const { commitSha } = yield* gitWorkflow.resolveRemoteTrackingCommit({
        cwd,
        refName: "HEAD",
        fallbackRemoteName: "origin",
      });
      // Start from the commit so the thread branch does not track the default branch.
      return { refName: commitSha, baseRefName: "refs/remotes/origin/HEAD" };
    }
    if (yield* gitWorkflow.hasCommit({ cwd, refName: "HEAD" })) {
      return { refName: "HEAD", baseRefName: undefined };
    }
    return null;
  });

  const recreateMissingWorktree = Effect.fn("restoreMissingWorktree.recreate")(function* (input: {
    readonly cwd: string;
    readonly worktreePath: string;
    readonly branch: string;
  }) {
    const { cwd, worktreePath, branch } = input;
    // Git keeps a deleted folder registered. Clear only this path, not every missing worktree.
    yield* git.execute({
      operation: "restoreMissingWorktree.unregister",
      cwd,
      args: ["worktree", "remove", worktreePath],
      allowNonZeroExit: true,
    });
    const localBranchNames = yield* gitWorkflow.listLocalBranchNames(cwd);
    if (localBranchNames.includes(branch)) {
      yield* gitWorkflow.createWorktree({ cwd, refName: branch, path: worktreePath });
      return;
    }
    // Push keeps the tracking ref current, so recovery reads it without fetching.
    const pushedRef = `refs/remotes/origin/${branch}`;
    if (yield* gitWorkflow.hasCommit({ cwd, refName: pushedRef })) {
      yield* gitWorkflow.createWorktree({
        cwd,
        refName: pushedRef,
        newRefName: branch,
        path: worktreePath,
      });
      return;
    }
    const base = yield* resolveRecreateBase(cwd);
    if (base === null) {
      return yield* new WorktreeRecreateNoBaseError({ worktreePath, branch });
    }
    yield* gitWorkflow.createWorktree({
      cwd,
      refName: base.refName,
      newRefName: branch,
      ...(base.baseRefName === undefined ? {} : { baseRefName: base.baseRefName }),
      path: worktreePath,
    });
  });

  return Effect.fn("restoreMissingWorktree")(function* (thread: WorktreeThread) {
    const { worktreePath, branch } = thread;
    if (worktreePath === null) return;
    const exists = yield* fileSystem.exists(worktreePath).pipe(Effect.orElseSucceed(() => true));
    if (!(yield* isManagedWorktreePath(worktreePath))) return;
    if (exists) {
      const marker = path.join(worktreePath, ".git");
      const intact = yield* fileSystem.readFileString(marker).pipe(
        Effect.flatMap((text) => {
          const target = /^gitdir: (.+)\s*$/.exec(text)?.[1];
          return target === undefined
            ? Effect.succeed(false)
            : fileSystem.exists(path.resolve(worktreePath, target, "HEAD"));
        }),
        Effect.catchTags({ PlatformError: () => fileSystem.exists(path.join(marker, "HEAD")) }),
        Effect.orElseSucceed(() => false),
      );
      if (!intact) return yield* new WorktreeGitDataMissingError({ worktreePath });
      return;
    }
    if (branch === null) return;
    const project = yield* projects.getById(thread.projectId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );
    if (project === undefined || path.resolve(project.workspaceRoot) === path.resolve(worktreePath))
      return;
    yield* Effect.logWarning("recreating missing worktree", {
      threadId: thread.id,
      worktreePath,
      branch,
    });
    // Recorded first, so a stop after `git worktree add` still leaves setup for the next turn.
    yield* setupScripts.markStripped(path.resolve(worktreePath), project.id);
    yield* recreateMissingWorktree({ cwd: project.workspaceRoot, worktreePath, branch }).pipe(
      Effect.mapError((cause) =>
        cause._tag === "WorktreeRecreateNoBaseError"
          ? cause
          : new WorktreeRecreateError({ worktreePath, branch, cause }),
      ),
    );
  });
});

// Worktree setup uses terminals, so preparation must stay outside TerminalManager's thread lock.
export const makePrepareTerminalLaunch = Effect.fn(
  "restoreMissingWorktree.makePrepareTerminalLaunch",
)(function* <LookupError>(
  getThreadShell: (threadId: ThreadId) => Effect.Effect<WorktreeThread | null, LookupError>,
) {
  const path = yield* Path.Path;
  const restoreMissingWorktree = yield* makeRestoreMissingWorktree;
  const setupScripts = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;

  return Effect.fn("restoreMissingWorktree.prepareTerminalLaunch")(function* <
    Input extends {
      readonly threadId: string;
      readonly cwd?: string | undefined;
      readonly worktreePath?: string | null | undefined;
    },
  >(input: Input) {
    const thread = yield* getThreadShell(ThreadId.make(input.threadId)).pipe(
      Effect.orElseSucceed(() => null),
    );
    const worktreePath = thread?.worktreePath ?? null;
    if (
      thread === null ||
      worktreePath === null ||
      !isWithinRoot(path, path.resolve(input.cwd ?? worktreePath), worktreePath)
    ) {
      return { input, prepare: TerminalLaunchPreparation.defaultValue() };
    }
    // A failed recreation leaves the folder missing, and the open reports that.
    const prepare = restoreMissingWorktree(thread).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("failed to recreate missing worktree", {
          threadId: thread.id,
          worktreePath,
          cause,
        }),
      ),
      Effect.andThen(
        setupScripts.setUpStripped({
          threadId: thread.id,
          projectId: thread.projectId,
          worktreePath: path.resolve(worktreePath),
        }),
      ),
      // Mirrors turn start: a shell waits for synchronous setup, not asynchronous setup.
      Effect.flatMap((setup) => (setup === null || setup.async ? Effect.void : setup.completion)),
      Effect.asVoid,
      Effect.catch((cause) =>
        Effect.logWarning("failed to set up worktree", {
          threadId: thread.id,
          worktreePath,
          cause,
        }),
      ),
    );
    // The lease must cover the worktree root, even when the terminal opens in a subdirectory.
    return { input: { ...input, worktreePath }, prepare };
  });
});
