import {
  type ProjectAction,
  type ProjectActionsInput,
  type ProjectActionsResult,
  type ProjectRunActionInput,
  type ProjectRunActionResult,
  ProjectScript,
  T3_PROJECT_FILE_NAME,
  TaskFolderError,
  linkOriginIsFenced,
} from "@t3tools/contracts";
import {
  nextProjectScriptId,
  projectScriptRuntimeEnv,
  projectScriptTerminalInput,
} from "@t3tools/shared/projectScripts";
import { nextTerminalId } from "@t3tools/shared/terminalLabels";
import { T3ProjectFileFromJson } from "@t3tools/shared/t3ProjectFile";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as LayoutCommandApprovals from "../workspace/LayoutCommandApprovals.ts";
import * as ProjectService from "./ProjectService.ts";

export class ProjectActions extends Context.Service<
  ProjectActions,
  {
    readonly read: (
      input: ProjectActionsInput,
      compareWorkingFile?: boolean,
    ) => Effect.Effect<ProjectActionsResult, TaskFolderError>;
    readonly run: (
      input: ProjectRunActionInput,
    ) => Effect.Effect<ProjectRunActionResult, TaskFolderError>;
  }
>()("t3/project/ProjectActions") {}

const sameScript = Schema.toEquivalence(ProjectScript);
const decode = Schema.decodeEffect(T3ProjectFileFromJson, { onExcessProperty: "error" });
const fail = (detail: string, cause?: unknown) =>
  new TaskFolderError({ operation: "read", detail, cause });
const scriptsFrom = Effect.fn("ProjectActions.scriptsFrom")(function* (
  text: string | null,
  location: string,
) {
  if (text === null) return [];
  const file = yield* decode(text).pipe(
    Effect.mapError((cause) => fail(`t3.json ${location} is invalid: ${cause.message}`, cause)),
  );
  const ids = new Set<string>();
  return (file.scripts ?? []).map((entry): ProjectScript => {
    const id = nextProjectScriptId(entry.name, ids);
    ids.add(id);
    return {
      ...entry,
      id,
      icon: entry.icon ?? "play",
      runOnWorktreeCreate: entry.runOnWorktreeCreate ?? false,
    };
  });
});

export const make = Effect.gen(function* () {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const approvals = yield* LayoutCommandApprovals.LayoutCommandApprovals;
  const policy = yield* ManagedPolicy.ManagedPolicy;
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ProjectionStore.ProjectionStoreV2;
  const terminals = yield* TerminalManager.TerminalManager;
  const random = yield* SecureRandom.SecureRandom;
  const policyAllowed = ManagedPolicy.deniedBy(policy, "worktreeLayoutCommands") === undefined;
  const readDisk = (dir: string) =>
    fs.readFileString(path.join(dir, T3_PROJECT_FILE_NAME)).pipe(
      Effect.catchIf(
        (e) => e.reason._tag === "NotFound",
        () => Effect.succeed(null),
      ),
    );

  const read: ProjectActions["Service"]["read"] = Effect.fn("ProjectActions.read")(
    function* (input, compareWorkingFile = true) {
      const project = Option.getOrUndefined(yield* projects.getById(input.projectId));
      if (!project || project.deletedAt !== null) return yield* fail("Project not found.");
      const cwd = project.workspaceRoot;
      let worktreePath = cwd;
      if (input.threadId !== undefined) {
        const thread = yield* threads.getThreadShell(input.threadId);
        if (!thread || thread.projectId !== project.id || thread.deletedAt !== null)
          return yield* fail("Thread not found in project.");
        worktreePath = thread.worktreePath ?? cwd;
      }
      const hasOrigin = yield* git.remoteExists({ cwd, remoteName: "origin" });
      const fetchedAt = hasOrigin
        ? yield* git.actionSourceFetchTime(cwd, input.fetch === true)
        : null;
      let branch = hasOrigin ? yield* git.resolveDefaultBranchName(cwd, "origin") : null;
      if (hasOrigin && branch === null) {
        for (const refName of ["main", "master"]) {
          if (yield* git.remoteBranchExists({ cwd, remoteName: "origin", refName })) {
            branch = refName;
            break;
          }
        }
      }
      let source: ProjectActionsResult["source"] = { kind: "disk" };
      let text: string | null;
      if (branch !== null) {
        const ref = `origin/${branch}`;
        const { commitSha: commit } = yield* git.resolveCommit({
          cwd,
          revision: `refs/remotes/${ref}`,
        });
        source = { kind: "remote", ref, commit, fetchedAt };
        const listing = yield* git.execute({
          operation: "ProjectActions.list",
          cwd,
          args: ["ls-tree", "--name-only", commit, "--", T3_PROJECT_FILE_NAME],
        });
        text =
          listing.stdout.length === 0
            ? null
            : (yield* git.execute({
                operation: "ProjectActions.readFile",
                cwd,
                args: ["show", `${commit}:./${T3_PROJECT_FILE_NAME}`],
              })).stdout;
      } else {
        text = yield* readDisk(cwd);
      }
      const scripts = yield* scriptsFrom(
        text,
        source.kind === "remote" ? `on ${source.ref}` : "in the project folder",
      );
      const approvedCommands = yield* approvals.actionTexts(project.id);
      const approved = new Set(approvedCommands);
      const actions = scripts.map((script): ProjectAction => ({
        ...script,
        approved: approved.has(script.command),
      }));
      const changedNames = new Set<string>();
      let unmerged = false;
      if (compareWorkingFile && source.kind === "remote") {
        const local = yield* readDisk(worktreePath);
        unmerged = local !== text;
        if (unmerged) {
          const localScripts = yield* scriptsFrom(local, "in the thread folder").pipe(
            Effect.orElseSucceed(() => []),
          );
          for (const action of [...scripts, ...localScripts]) {
            const same = (candidate: ProjectScript) => sameScript(candidate, action);
            if (!scripts.some(same) || !localScripts.some(same)) changedNames.add(action.name);
          }
        }
      }
      return {
        source,
        actions,
        changedNames: [...changedNames],
        unmerged,
        approvedCommands,
        policyAllowed,
      };
    },
    Effect.mapError((cause) =>
      cause._tag === "TaskFolderError"
        ? cause
        : fail(`Could not read project actions: ${cause.message}`, cause),
    ),
  );

  const run: ProjectActions["Service"]["run"] = Effect.fn("ProjectActions.run")(
    function* (input) {
      if (!policyAllowed) return yield* fail("Project commands are disabled by managed policy.");
      const project = Option.getOrUndefined(yield* projects.getById(input.projectId));
      const thread = yield* threads.getThreadShell(input.threadId);
      if (
        !project ||
        project.deletedAt !== null ||
        !thread ||
        thread.projectId !== project.id ||
        thread.deletedAt !== null
      )
        return yield* fail("Thread not found in project.");
      if (thread.linkOrigin && linkOriginIsFenced(thread.linkOrigin))
        return yield* fail("Project actions are disabled for this linked thread.");
      const current = Effect.gen(function* () {
        const { actions } = yield* read({ projectId: project.id }, false);
        const action = actions.find((entry) => entry.id === input.actionId);
        if (!action || action.command !== input.expectedCommand)
          return yield* fail("The action changed. Review the current command.");
        if (!action.approved) return yield* fail("This action needs approval.");
        return action;
      });
      const action = yield* current;
      const terminalId = nextTerminalId([], yield* random.uuidV4());
      const cwd = thread.worktreePath ?? project.workspaceRoot;
      yield* terminals.open({
        threadId: thread.id,
        terminalId,
        cwd,
        worktreePath: thread.worktreePath,
        stopOnSettle: action.stopOnSettle ?? false,
        env: projectScriptRuntimeEnv({
          project: { cwd: project.workspaceRoot },
          worktreePath: thread.worktreePath,
        }),
      });
      yield* LayoutCommandApprovals.withActionApprovalLease(
        project.id,
        current.pipe(
          Effect.flatMap((allowed) =>
            terminals.write({
              threadId: thread.id,
              terminalId,
              data: projectScriptTerminalInput(allowed.command),
            }),
          ),
          Effect.onError(() =>
            terminals.close({ threadId: thread.id, terminalId }).pipe(Effect.ignore),
          ),
        ),
      );
      return { terminalId };
    },
    Effect.mapError((cause) =>
      cause._tag === "TaskFolderError" ? cause : fail("Could not run project action.", cause),
    ),
  );

  return ProjectActions.of({ read, run });
});
export const layer = Layer.effect(ProjectActions, make);
