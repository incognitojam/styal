import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as LayoutCommandApprovals from "../workspace/LayoutCommandApprovals.ts";
import * as ProjectActions from "./ProjectActions.ts";
import * as ProjectService from "./ProjectService.ts";

const infra = GitVcsDriver.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "actions-test-" })),
  Layer.provideMerge(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
);

it.live(
  "runs only canonical approved commands while source precedence, working files and approvals change",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const git = yield* GitVcsDriver.GitVcsDriver;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "action-source-" });
      const origin = yield* fs.makeTempDirectoryScoped({ prefix: "action-origin-" });
      const worktree = yield* fs.makeTempDirectoryScoped({ prefix: "action-thread-" });
      const projectId = ProjectId.make("project:actions");
      const threadId = ThreadId.make("thread:actions");
      const approved: string[] = [];
      const writes: string[] = [];
      const project = {
        id: projectId,
        title: "Example",
        workspaceRoot: cwd,
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        deletedAt: null,
      };
      const dependencies = Layer.mergeAll(
        Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedSome(project) }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadShell: () =>
            Effect.succeed({ ...liveThreadShell(threadId), projectId, worktreePath: worktree }),
        }),
        Layer.mock(LayoutCommandApprovals.LayoutCommandApprovals)({
          actionTexts: () => Effect.succeed([...approved]),
        }),
        Layer.mock(TerminalManager.TerminalManager)({
          open: (input) =>
            Effect.succeed({
              threadId,
              terminalId: input.terminalId!,
              cwd: input.cwd,
              worktreePath: worktree,
              status: "running",
              pid: 1,
              history: "",
              exitCode: null,
              exitSignal: null,
              label: "sh",
              updatedAt: "2026-01-01T00:00:00.000Z",
            }),
          write: (input) =>
            Effect.sync(() => {
              writes.push(input.data);
            }),
        }),
      );
      const service = yield* ProjectActions.make.pipe(
        Effect.provide(dependencies),
        Effect.provide(ManagedPolicy.layerTest()),
      );
      const run = (expectedCommand: string) =>
        service.run({ projectId, threadId, actionId: "test", expectedCommand });
      const read = service.read({ projectId, threadId });
      const runGit = (...args: string[]) =>
        git.execute({ cwd, args, operation: "action source fixture" });
      const write = (dir: string, command: string) =>
        fs.writeFileString(
          path.join(dir, "t3.json"),
          JSON.stringify({ scripts: [{ name: "Test", command }] }),
        );
      const commit = (message: string) =>
        runGit(
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "-c",
          "commit.gpgSign=false",
          "commit",
          "--quiet",
          "-m",
          message,
        );
      yield* runGit("init", "--bare", "--quiet", "-b", "trunk", origin);
      yield* runGit("init", "--quiet", "-b", "trunk");
      yield* write(cwd, "echo disk");
      yield* write(worktree, "echo thread");
      expect(yield* read).toMatchObject({
        source: { kind: "disk" },
        actions: [{ command: "echo disk", approved: false }],
      });
      yield* runGit("remote", "add", "origin", origin);
      expect((yield* read).source.kind).toBe("disk");
      yield* write(cwd, " echo check ");
      yield* runGit("add", "t3.json");
      yield* commit("action");
      for (const ref of ["master", "main", "trunk"]) {
        yield* runGit("push", "--quiet", "origin", `HEAD:refs/heads/${ref}`);
        if (ref === "trunk")
          yield* runGit("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
        expect((yield* read).source).toMatchObject({ kind: "remote", ref: `origin/${ref}` });
      }
      yield* write(cwd, "echo uncommitted");
      expect(yield* read).toMatchObject({
        actions: [{ command: " echo check ", approved: false }],
        unmerged: true,
        changedNames: ["Test"],
      });
      expect((yield* run("echo thread").pipe(Effect.flip)).detail).toContain("changed");
      approved.push("echo check");
      expect((yield* run(" echo check ").pipe(Effect.flip)).detail).toContain("approval");
      approved.push(" echo check ");
      yield* run(" echo check ");
      expect(writes).toEqual(["  echo check \r"]);
      const policy = yield* ProjectActions.make.pipe(
        Effect.provide(dependencies),
        Effect.provide(
          ManagedPolicy.layerTest({
            schemaVersion: 1,
            organization: "Example",
            limits: { worktreeLayoutCommands: false },
          }),
        ),
      );
      expect(
        (yield* policy
          .run({ projectId, threadId, actionId: "test", expectedCommand: " echo check " })
          .pipe(Effect.flip)).detail,
      ).toContain("policy");
      yield* write(cwd, "echo changed");
      yield* runGit("add", "t3.json");
      yield* commit("change action");
      // Push by path so only the server fetch can advance origin/trunk in this checkout.
      yield* runGit("push", "--quiet", origin, "HEAD:refs/heads/trunk");
      expect((yield* read).actions[0]?.command).toBe(" echo check ");
      const refreshed = yield* service.read({ projectId, threadId, fetch: true });
      expect(refreshed).toMatchObject({
        source: { kind: "remote", ref: "origin/trunk", fetchedAt: expect.any(String) },
        actions: [{ command: "echo changed", approved: false }],
      });
      expect((yield* run(" echo check ").pipe(Effect.flip)).detail).toContain("changed");
      const twoScripts = [
        { name: "Test", command: "echo changed" },
        { name: "Steady", command: "echo steady" },
      ];
      yield* fs.writeFileString(path.join(cwd, "t3.json"), JSON.stringify({ scripts: twoScripts }));
      yield* runGit("add", "t3.json");
      yield* commit("add steady action");
      yield* runGit("update-ref", "refs/remotes/origin/trunk", "HEAD");
      yield* fs.writeFileString(
        path.join(worktree, "t3.json"),
        JSON.stringify({ scripts: twoScripts }, null, 2),
      );
      expect((yield* read).changedNames).toEqual([]);
      yield* fs.writeFileString(
        path.join(worktree, "t3.json"),
        JSON.stringify({ scripts: [{ name: "Test", command: "echo branch" }, twoScripts[1]] }),
      );
      expect((yield* read).changedNames).toEqual(["Test"]);
      yield* fs.writeFileString(
        path.join(cwd, "t3.json"),
        '{"scripts":[{"name":"Invalid","command":"true","icon":"unknown"}]}',
      );
      yield* runGit("add", "t3.json");
      yield* commit("invalid");
      yield* runGit("update-ref", "refs/remotes/origin/trunk", "HEAD");
      expect((yield* read.pipe(Effect.flip)).detail).toMatch(/origin\/trunk.*invalid/);
      expect((yield* run("echo changed").pipe(Effect.flip)).detail).toMatch(
        /origin\/trunk.*invalid/,
      );
      expect(writes).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(infra)),
);
