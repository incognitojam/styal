import { assert, describe, it, vi } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { layerMemory } from "../persistence/Sqlite.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as TurnItemPositions from "../orchestration-v2/TurnItemPositionStore.ts";
import * as LegacyImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectFileActionApprovals from "./ProjectFileActionApprovals.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ProjectSetupScriptRunner from "./ProjectSetupScriptRunner.ts";

const database = layerMemory;
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
      Layer.mock(ProjectFileActionApprovals.ProjectFileActionApprovals)({
        automationConfig: () => Effect.succeed(null),
      }),
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

it.effect(
  "runs the settle script in one retained terminal per thread, outside the checkout",
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
    const projectId = ProjectId.make("project:settle-v2");
    const threadId = ThreadId.make("thread:settle-v2");
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
        {
          id: "clean",
          name: "Clean",
          command: "cargo clean",
          icon: "build" as const,
          runOnWorktreeCreate: false,
          runOnSettle: true,
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
      Layer.mock(ProjectFileActionApprovals.ProjectFileActionApprovals)({
        automationConfig: () => Effect.succeed(null),
      }),
      ServerSettings.layerTest(),
    );
    const runner = ProjectSetupScriptRunner.layer.pipe(Layer.provide(dependencies));
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES (${projectId}, 'Settle', '/synthetic/repo', '[]', ${project.createdAt}, ${project.updatedAt})`;
      yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, runtime_mode, interaction_mode, created_at, updated_at)
    VALUES (${threadId}, ${projectId}, 'Settle', 'full-access', 'default', ${project.createdAt}, ${project.updatedAt})`;
      yield* (yield* LegacyImporter.LegacyV1ThreadImporter).reconcileShells;
      const service = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const settleRows = Effect.map(projections.getThreadProjection(threadId), (projection) =>
        projection.turnItems.filter(
          (item) => item.type === "command_execution" && item.setupScript?.scriptId === "clean",
        ),
      );
      const settle = (worktreePath: string) =>
        service.runForThread({ threadId, projectId, worktreePath, trigger: "settle" });

      const first = yield* settle("/synthetic/repo-worktree");
      assert.equal(first.status, "started");
      if (first.status !== "started") return;
      assert.equal(first.terminalId, "settle-clean");
      assert.equal(openCommand.mock.calls[0]?.[0].command, "cargo clean");
      assert.equal(openCommand.mock.calls[0]?.[0].label, "Clean");
      assert.equal(openCommand.mock.calls[0]?.[0].cwd, "/synthetic/repo-worktree");

      // Settling again while cleanup runs must not attach a second run to it.
      assert.equal((yield* settle("/synthetic/repo-worktree")).status, "already-running");
      assert.equal(openCommand.mock.calls.length, 1);

      yield* Effect.forEach([...listeners], (listener) =>
        listener({
          type: "exited",
          threadId,
          terminalId: "settle-clean",
          exitCode: 0,
          exitSignal: null,
        }),
      );
      const [completed] = yield* settleRows;
      assert.equal(completed?.status, "completed");
      assert.equal(completed?.title, "Clean");

      const second = yield* settle("/synthetic/repo-worktree");
      assert.equal(second.status === "started" && second.terminalId, "settle-clean");
      assert.equal(openCommand.mock.calls.length, 2);
      yield* Effect.forEach([...listeners], (listener) =>
        listener({
          type: "exited",
          threadId,
          terminalId: "settle-clean",
          exitCode: 1,
          exitSignal: null,
        }),
      );
      assert.deepEqual(
        (yield* settleRows).map((item) => item.status),
        ["completed", "failed"],
      );

      // The project's own checkout is skipped without running or logging a row.
      assert.equal((yield* settle("/synthetic/repo/")).status, "not-a-worktree");
      assert.equal(openCommand.mock.calls.length, 2);
      assert.equal((yield* settleRows).length, 2);
    }).pipe(Effect.provide(Layer.mergeAll(dependencies, runner)));
  },
);

describe("styal.json setup actions", () => {
  const fileSetup = {
    id: "file-setup",
    name: "Bootstrap",
    command: "./scripts/bootstrap.sh",
    icon: "configure" as const,
    runOnWorktreeCreate: true,
  };
  const approval = {
    command: fileSetup.command,
    roles: ["setup" as const],
    approvedAt: "2026-10-21T00:00:00.000Z",
  };

  const runWith = (options: {
    readonly suffix: string;
    readonly localScripts: ReadonlyArray<{
      id: string;
      name: string;
      command: string;
      icon: "configure";
      runOnWorktreeCreate: boolean;
    }>;
    readonly approved: boolean;
  }) => {
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
    const subscribe: TerminalManager.TerminalManager["Service"]["subscribe"] = () =>
      Effect.succeed(() => {});
    const projectId = ProjectId.make(`project:file-${options.suffix}`);
    const threadId = ThreadId.make(`thread:file-${options.suffix}`);
    const project = {
      id: projectId,
      title: "Project",
      workspaceRoot: "/synthetic/repo",
      repositoryIdentity: null,
      faviconPath: null,
      defaultModelSelection: null,
      scripts: options.localScripts,
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
      Layer.mock(ProjectFileActionApprovals.ProjectFileActionApprovals)({
        automationConfig: () => Effect.succeed({ source: "styal.json", actions: [fileSetup] }),
      }),
      ServerSettings.layerTest(
        options.approved
          ? {
              projectFileActionApprovals: {
                [`project:${projectId}`]: { [fileSetup.id]: approval },
              },
            }
          : {},
      ),
    );
    const runner = ProjectSetupScriptRunner.layer.pipe(Layer.provide(dependencies));
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES (${projectId}, 'File', '/synthetic/repo', '[]', ${project.createdAt}, ${project.updatedAt})`;
      yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, runtime_mode, interaction_mode, created_at, updated_at)
      VALUES (${threadId}, ${projectId}, 'File', 'full-access', 'default', ${project.createdAt}, ${project.updatedAt})`;
      yield* (yield* LegacyImporter.LegacyV1ThreadImporter).reconcileShells;
      const service = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const result = yield* service.runForThread({
        threadId,
        projectId,
        worktreePath: "/synthetic/repo-worktree",
      });
      const rows = (yield* projections.getThreadProjection(threadId)).turnItems.filter(
        (item) => item.type === "command_execution",
      );
      return { result, rows, openCommand, projectId };
    }).pipe(Effect.provide(Layer.mergeAll(dependencies, runner)));
  };

  it.effect("waits for approval instead of running an unapproved file action", () =>
    Effect.gen(function* () {
      const { result, rows, openCommand, projectId } = yield* runWith({
        suffix: "unapproved",
        localScripts: [],
        approved: false,
      });
      assert.deepEqual(result, {
        status: "awaiting-approval",
        scriptId: "file-setup",
        scriptName: "Bootstrap",
      });
      assert.equal(openCommand.mock.calls.length, 0);
      const [row] = rows;
      assert.equal(rows.length, 1);
      assert.equal(row?.status, "idle");
      assert.deepEqual(row?.type === "command_execution" && row.setupScript?.awaitingApproval, {
        projectId,
        actionId: "file-setup",
      });
    }),
  );

  it.effect("runs a file action whose exact command was approved", () =>
    Effect.gen(function* () {
      const { result, openCommand } = yield* runWith({
        suffix: "approved",
        localScripts: [],
        approved: true,
      });
      assert.equal(result.status, "started");
      assert.equal(openCommand.mock.calls[0]?.[0].command, "./scripts/bootstrap.sh");
    }),
  );

  it.effect("prefers a saved setup action over an approved file one", () =>
    Effect.gen(function* () {
      const { result, openCommand } = yield* runWith({
        suffix: "local",
        localScripts: [
          {
            id: "setup",
            name: "Install dependencies",
            command: "vp install",
            icon: "configure",
            runOnWorktreeCreate: true,
          },
        ],
        approved: true,
      });
      assert.equal(result.status, "started");
      assert.equal(openCommand.mock.calls[0]?.[0].command, "vp install");
    }),
  );
});
