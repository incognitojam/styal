import { assert, it, vi } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as TurnItemPositions from "../orchestration-v2/TurnItemPositionStore.ts";
import * as LegacyImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ProjectSetupScriptRunner from "./ProjectSetupScriptRunner.ts";

const database = SqlitePersistenceMemory;
const stores = Layer.mergeAll(
  database,
  EventStore.layer.pipe(Layer.provide(database)),
  ProjectionStore.layer.pipe(Layer.provide(database)),
  TurnItemPositions.layer.pipe(Layer.provide(database)),
);
const sink = EventSink.layer.pipe(Layer.provide(stores));
const importer = LegacyImporter.layer.pipe(Layer.provide(Layer.mergeAll(stores, sink)));

it.effect(
  "runs finite setup commands and records configured identity and actual outcomes in V2",
  () => {
    const listeners = new Set<
      Parameters<TerminalManager.TerminalManager["Service"]["subscribe"]>[0]
    >();
    const openCommand = vi.fn(
      (input: Parameters<TerminalManager.TerminalManager["Service"]["openCommand"]>[0]) =>
        Effect.succeed({
          threadId: input.threadId,
          terminalId: input.terminalId,
          cwd: input.cwd,
          worktreePath: input.worktreePath ?? null,
          status: "running" as const,
          pid: 123,
          history: "",
          exitCode: null,
          exitSignal: null,
          label: "Shell",
          updatedAt: "2026-06-20T00:00:00.000Z",
        }),
    );
    const subscribe: TerminalManager.TerminalManager["Service"]["subscribe"] = (listener) =>
      Effect.sync(() => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      });
    const projectId = ProjectId.make("project:setup-v2");
    const threadId = ThreadId.make("thread:setup-v2");
    const project = {
      id: projectId,
      title: "Project",
      workspaceRoot: "/synthetic/repo",
      repositoryIdentity: null,
      faviconPath: null,
      defaultModelSelection: null,
      scripts: [
        {
          id: "setup",
          name: "Install dependencies",
          command: "vp install",
          icon: "configure" as const,
          runOnWorktreeCreate: true,
        },
      ],
      createdAt: "2026-06-20T00:00:00.000Z",
      updatedAt: "2026-06-20T00:00:00.000Z",
      deletedAt: null,
    };
    const dependencies = Layer.mergeAll(
      stores,
      sink,
      importer,
      Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedSome(project) }),
      Layer.mock(TerminalManager.TerminalManager)({ openCommand, subscribe }),
      ServerSettings.layerTest(),
    );
    const runner = ProjectSetupScriptRunner.layer.pipe(Layer.provide(dependencies));
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES (${projectId}, 'Setup', '/synthetic/repo', '[]', ${project.createdAt}, ${project.updatedAt})`;
      yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, runtime_mode, interaction_mode, created_at, updated_at)
      VALUES (${threadId}, ${projectId}, 'Setup', 'full-access', 'default', ${project.createdAt}, ${project.updatedAt})`;
      yield* (yield* LegacyImporter.LegacyV1ThreadImporter).reconcileShells;
      const service = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const output: string[] = [];
      const result = yield* service.runForThread({
        threadId,
        projectId,
        worktreePath: "/synthetic/repo-worktree",
        observeCompletion: {
          onOutputLine: (line) =>
            Effect.sync(() => {
              output.push(line);
            }),
        },
      });
      assert.equal(result.status, "started");
      if (result.status !== "started") return;
      assert.equal(result.scriptName, "Install dependencies");
      assert.equal(openCommand.mock.calls[0]?.[0].command, "vp install");
      assert.deepEqual(openCommand.mock.calls[0]?.[0].env, {
        STYAL_PROJECT_ROOT: "/synthetic/repo",
        STYAL_WORKTREE_PATH: "/synthetic/repo-worktree",
        T3CODE_PROJECT_ROOT: "/synthetic/repo",
        T3CODE_WORKTREE_PATH: "/synthetic/repo-worktree",
        NO_COLOR: "1",
        FORCE_COLOR: "0",
      });
      yield* Effect.forEach([...listeners], (listener) =>
        listener({
          type: "output",
          threadId,
          terminalId: result.terminalId,
          data: "Downloading 10%\rDownloading 20%\r\nDone\n",
        }),
      );
      assert.deepEqual(output, ["Downloading 10%", "Downloading 20%", "Done"]);
      const running = (yield* projections.getThreadProjection(threadId)).turnItems.find(
        (item) => item.type === "command_execution",
      );
      assert.equal(running?.status, "running");
      assert.equal(
        running?.type === "command_execution" && running.setupScript?.scriptName,
        "Install dependencies",
      );
      yield* Effect.forEach([...listeners], (listener) =>
        listener({
          type: "exited",
          threadId,
          terminalId: result.terminalId,
          exitCode: 0,
          exitSignal: null,
        }),
      );
      assert.equal((yield* result.completion!).exitCode, 0);
      const completed = (yield* projections.getThreadProjection(threadId)).turnItems.find(
        (item) => item.id === running?.id,
      );
      assert.equal(completed?.status, "completed");
      assert.equal(completed?.type === "command_execution" && completed.exitCode, 0);

      const failed = yield* service.runForThread({
        threadId,
        projectId,
        worktreePath: "/synthetic/repo-worktree",
      });
      assert.equal(failed.status, "started");
      if (failed.status !== "started") return;
      yield* Effect.forEach([...listeners], (listener) =>
        listener({
          type: "exited",
          threadId,
          terminalId: failed.terminalId,
          exitCode: 2,
          exitSignal: null,
        }),
      );
      const failure = (yield* projections.getThreadProjection(threadId)).turnItems.find(
        (item) => item.type === "command_execution" && item.setupScript?.runId === failed.runId,
      );
      assert.equal(failure?.status, "failed");
      assert.equal(failure?.type === "command_execution" && failure.exitCode, 2);

      const stopped = yield* service.runForThread({
        threadId,
        projectId,
        worktreePath: "/synthetic/repo-worktree",
      });
      assert.equal(stopped.status, "started");
      if (stopped.status !== "started") return;
      yield* Effect.forEach([...listeners], (listener) =>
        listener({ type: "closed", threadId, terminalId: stopped.terminalId }),
      );
      const interrupted = (yield* projections.getThreadProjection(threadId)).turnItems.find(
        (item) => item.type === "command_execution" && item.setupScript?.runId === stopped.runId,
      );
      assert.equal(interrupted?.status, "interrupted");
      const guarded = yield* service.runForThread({
        threadId,
        projectId,
        worktreePath: project.workspaceRoot,
      });
      assert.equal(guarded.status, "not-a-worktree");
      assert.equal(openCommand.mock.calls.length, 3);
    }).pipe(Effect.provide(Layer.mergeAll(dependencies, runner)));
  },
);
