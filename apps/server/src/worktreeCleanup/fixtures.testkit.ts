import * as Path from "effect/Path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NodeServices from "../nodeServices.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as DateTime from "effect/DateTime";
import {
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

export function shell(
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: ThreadId.make("thread-1"),
      parentThreadId: null,
      relationshipToParent: null,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    status: "idle",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    createdAt: DateTime.makeUnsafe(0),
    updatedAt: DateTime.makeUnsafe(0),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

export const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const base = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "cleanup-safety-" }));
  const dependencies = GitVcsDriver.layer.pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), base)),
  );
  return yield* Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const root = path.join(base, "project");
    yield* fs.makeDirectory(root);
    const command = (cwd: string, args: readonly string[]) =>
      git.execute({ operation: "fixture", cwd, args });
    yield* command(root, ["init", "-b", "main"]);
    yield* command(root, ["config", "init.defaultBranch", "main"]);
    yield* command(root, ["config", "user.name", "Fixture"]);
    yield* command(root, ["config", "user.email", "fixture@example.invalid"]);
    yield* fs.writeFileString(
      `${root}/.gitignore`,
      "**/dist/\n**/node_modules/\n.scratch/\ncache/\n",
    );
    yield* command(root, ["add", "."]);
    yield* command(root, ["commit", "-m", "fixture"]);
    const worktree = path.join(config.worktreesDir, "fixture", "quiet");
    yield* fs.makeDirectory(`${config.worktreesDir}/fixture`, { recursive: true });
    yield* command(root, ["worktree", "add", "--detach", worktree]);
    const write = (relative: string, text = "synthetic") =>
      Effect.gen(function* () {
        const file = `${worktree}/${relative}`;
        yield* fs.makeDirectory(file.slice(0, file.lastIndexOf("/")), { recursive: true });
        yield* fs.writeFileString(file, text);
      });
    return { fs, base, root, worktree, command, write, config, git };
  }).pipe(Effect.provide(dependencies));
});
export const nodeLayer = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
