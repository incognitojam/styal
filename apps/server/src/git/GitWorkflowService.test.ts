import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import { layerMemory } from "../persistence/Sqlite.ts";
import * as WorkspacePortAllocator from "../workspace/WorkspacePortAllocator.ts";

function layer(input: {
  readonly detect: VcsDriverRegistry.VcsDriverRegistry["Service"]["detect"];
}) {
  return GitWorkflowService.layer.pipe(
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        detect: input.detect,
      }),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(Layer.mock(GitManager.GitManager)({})),
    Layer.provide(Layer.mock(WorkspacePortAllocator.WorkspacePortAllocator)({})),
  );
}

const realGitLayer = (prefix: string) =>
  GitWorkflowService.layer.pipe(
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        resolve: () => Effect.succeed({ kind: "git" } as VcsDriverRegistry.VcsDriverHandle),
      }),
    ),
    Layer.provide(Layer.mock(GitManager.GitManager)({})),
    Layer.provideMerge(WorkspacePortAllocator.layer),
    Layer.provideMerge(layerMemory),
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix }).pipe(Layer.provide(NodeServices.layer)),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

it.layer(NodeServices.layer)("GitWorkflowService", (it) => {
  it.effect("returns an empty local status when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const status = yield* workflow.localStatus({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(status, {
        isRepo: false,
        hasHeadCommit: false,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
      });
    }).pipe(
      Effect.provide(
        layer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("returns an empty full status when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const status = yield* workflow.status({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(status, {
        isRepo: false,
        hasHeadCommit: false,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        aheadOfDefaultCount: 0,
        pr: null,
      });
    }).pipe(
      Effect.provide(
        layer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("finds a name among the refs of every namespace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ref-named-" });
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      for (const args of [
        ["init", "-b", "main"],
        ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
        ["update-ref", "refs/remotes/upstream/feature/topic", "HEAD"],
        ["symbolic-ref", "refs/remotes/origin/alias", "refs/heads/main"],
        ["update-ref", "refs/mirror/origin/mirrored", "HEAD"],
      ]) {
        yield* driver.execute({ operation: "test.setupRepo", cwd, args });
      }
      const found = yield* Effect.forEach(
        ["main", "feature/topic", "alias", "mirrored", "t3/renamed", "feature/*"],
        (refName) => workflow.hasRefNamed({ cwd, refName }),
      );
      assert.deepEqual(found, [true, true, true, true, false, false]);
    }).pipe(Effect.scoped, Effect.provide(realGitLayer("t3-ref-named-"))),
  );

  it.effect("removing a worktree frees its port range", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sql = yield* SqlClient.SqlClient;
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const ports = yield* WorkspacePortAllocator.WorkspacePortAllocator;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-remove-port-" });
      const worktreePath = path.join(cwd, "worktrees", "feature");
      for (const args of [
        ["init", "-b", "main"],
        ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
        ["worktree", "add", "-b", "feature", worktreePath],
      ]) {
        yield* driver.execute({ operation: "test.setupRepo", cwd, args });
      }
      yield* ports.getBasePort(cwd);
      yield* ports.getBasePort(worktreePath);

      yield* workflow.removeWorktree({ cwd, path: "worktrees/feature", force: true });

      const reserved = yield* sql<{ readonly workspacePath: string }>`
        SELECT workspace_path AS "workspacePath" FROM workspace_port_allocations
      `;
      assert.deepStrictEqual(
        reserved.map(({ workspacePath }) => workspacePath),
        [path.resolve(cwd)],
      );
      assert.isFalse(yield* fileSystem.exists(worktreePath));
    }).pipe(Effect.scoped, Effect.provide(realGitLayer("t3-remove-port-"))),
  );
});
