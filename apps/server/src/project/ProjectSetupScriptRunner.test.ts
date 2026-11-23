import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it, vi } from "@effect/vitest";
import { ProjectId, TerminalCwdNotFoundError, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as PhysicalFileSystem from "@t3tools/shared/PhysicalFileSystem";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { layerMemory } from "../persistence/Sqlite.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as TurnItemPositions from "../orchestration-v2/TurnItemPositionStore.ts";
import * as LegacyImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as WorkspacePortAllocator from "../workspace/WorkspacePortAllocator.ts";
import { makeWorkspaceLease } from "../workspace/workspaceLease.ts";
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
const reservedPorts = Layer.mock(WorkspacePortAllocator.WorkspacePortAllocator)({
  getBasePort: () => Effect.succeed(20_000),
});
const importer = LegacyImporter.layer.pipe(Layer.provide(Layer.mergeAll(stores, sink)));
// Workspace leases resolve paths; the synthetic ones fall back to their resolved form.
const platform = Layer.mergeAll(FileSystem.layerNoop({}), Path.layer, PhysicalFileSystem.layer);

it.effect(
  "runs finite setup commands and records configured identity and actual outcomes in V2",
  () => {
    const listeners = new Set<
      Parameters<TerminalManager.TerminalManager["Service"]["subscribe"]>[0]
    >();
    const openCommand = vi.fn(
      (input: Parameters<TerminalManager.TerminalManager["Service"]["openCommand"]>[0]) =>
        Effect.gen(function* () {
          const snapshot = {
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
          };
          yield* Effect.forEach([...listeners], (listener) =>
            listener({
              type: "restarted",
              threadId: input.threadId,
              terminalId: input.terminalId,
              snapshot,
            }),
          );
          return snapshot;
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
      platform,
      stores,
      sink,
      importer,
      Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedSome(project) }),
      Layer.mock(TerminalManager.TerminalManager)({ openCommand, subscribe }),
      reservedPorts,
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
      assert.equal(listeners.size, 1);
      assert.equal((yield* result.completion!).exitCode, 0);
      const completed = (yield* projections.getThreadProjection(threadId)).turnItems.find(
        (item) => item.id === running?.id,
      );
      assert.equal(completed?.status, "completed");
      assert.equal(completed?.type === "command_execution" && completed.exitCode, 0);

      for (const { exitCode, exitSignal } of [
        { exitCode: 2, exitSignal: null },
        { exitCode: 0, exitSignal: 15 },
      ]) {
        const failed = yield* service.runForThread({
          threadId,
          projectId,
          worktreePath: "/synthetic/repo-worktree",
          observeCompletion: {},
        });
        assert.equal(failed.status, "started");
        if (failed.status !== "started") return;
        yield* Effect.forEach([...listeners], (listener) =>
          listener({
            type: "exited",
            threadId,
            terminalId: failed.terminalId,
            exitCode,
            exitSignal,
          }),
        );
        assert.deepEqual(yield* failed.completion!, { exitCode, exitSignal, durationMs: 0 });
        const failure = (yield* projections.getThreadProjection(threadId)).turnItems.find(
          (item) => item.type === "command_execution" && item.setupScript?.runId === failed.runId,
        );
        assert.equal(failure?.status, "failed");
        assert.equal(failure?.type === "command_execution" && failure.exitCode, exitCode);
      }

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
      assert.equal(openCommand.mock.calls.length, 4);
    }).pipe(Effect.provide(Layer.mergeAll(dependencies, runner)));
  },
);

it.effect(
  "one setup runs per worktree root, started before an interrupted caller's lease ends",
  () =>
    Effect.gen(function* () {
      const root = "/synthetic/worktrees/project/feature";
      const withWorkspaceLease = yield* makeWorkspaceLease.pipe(Effect.provide(platform));
      const reading = yield* Deferred.make<void>();
      const read = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const events: Array<string> = [];
      const consumed: Array<string> = [];
      const setUpStripped = yield* ProjectSetupScriptRunner.makeSetUpStripped({
        isStripped: () => Effect.sync(() => consumed.length === 0),
        consumeStripped: (path) => Effect.sync(() => consumed.push(path) > 0),
        // Until setup's terminal exists, only the caller's lease keeps cleanup out of the root.
        runForThread: (input) =>
          Deferred.succeed(reading, undefined).pipe(
            Effect.andThen(Deferred.await(read)),
            Effect.andThen(Effect.sync(() => events.push(`setup terminal for ${input.threadId}`))),
            Effect.as({
              status: "started" as const,
              runId: "setup",
              scriptId: "setup",
              scriptName: "Setup",
              scriptCommand: "synthetic setup",
              terminalId: "setup-setup",
              cwd: root,
              async: false,
              completion: Deferred.await(finish).pipe(
                Effect.as({ exitCode: 0, exitSignal: null, durationMs: 0 }),
              ),
            }),
          ),
      });
      const first = yield* withWorkspaceLease(
        root,
        setUpStripped({ threadId: "thread-a", worktreePath: root }),
      ).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(reading);
      const interrupted = yield* Fiber.interrupt(first).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      const cleanup = yield* withWorkspaceLease(
        root,
        Effect.sync(() => events.push("cleanup")),
      ).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(read, undefined);
      yield* Fiber.join(interrupted);
      yield* Fiber.join(cleanup);
      // Another thread in the same worktree waits for that run instead of starting its own.
      const joined = yield* setUpStripped({ threadId: "thread-b", worktreePath: root });
      yield* Deferred.succeed(finish, undefined);
      assert.deepEqual(yield* joined!.completion, { exitCode: 0, exitSignal: null, durationMs: 0 });
      assert.deepEqual(events, ["setup terminal for thread-a", "cleanup"]);
      assert.deepEqual(consumed, [root]);
    }).pipe(Effect.scoped),
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
      platform,
      stores,
      sink,
      importer,
      Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedSome(project) }),
      Layer.mock(TerminalManager.TerminalManager)({ openCommand, subscribe }),
      reservedPorts,
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
    readonly approveAfterWaiting?: boolean;
    readonly stripped?: boolean;
    readonly worktreePath?: string;
    readonly onOpenCommand?: Effect.Effect<void>;
    readonly exitCode?: number;
    readonly launch?: "fails" | "errors";
    readonly sameThreadShell?: "reuses" | "replaces" | "replaced";
    readonly portsExhausted?: boolean;
  }) => {
    let opens = 0;
    const openCommand = vi.fn(
      (input: Parameters<TerminalManager.TerminalManager["Service"]["openCommand"]>[0]) => {
        const snapshot = {
          threadId: input.threadId,
          terminalId: input.terminalId,
          cwd: input.cwd,
          worktreePath: input.worktreePath ?? null,
          status: options.launch === "errors" ? ("error" as const) : ("running" as const),
          pid: 123,
          history: "",
          exitCode: null,
          exitSignal: null,
          label: "Shell",
          updatedAt: "2026-06-20T00:00:00.000Z",
        };
        // As TerminalManager reports a process it replaced for a changed launch: only the start.
        const replaces =
          (opens += 1) > 1 &&
          (options.sameThreadShell === "replaces" || options.sameThreadShell === "replaced");
        return (options.onOpenCommand ?? Effect.void).pipe(
          Effect.andThen(
            options.launch === "fails"
              ? Effect.fail(new TerminalCwdNotFoundError({ cwd: input.cwd }))
              : Effect.void,
          ),
          Effect.andThen(
            replaces
              ? Effect.forEach([...listeners], (listener) =>
                  listener({
                    type: "started",
                    threadId: input.threadId,
                    terminalId: input.terminalId,
                    snapshot,
                  }),
                )
              : Effect.void,
          ),
          Effect.as(snapshot),
        );
      },
    );
    const listeners = new Set<
      Parameters<TerminalManager.TerminalManager["Service"]["subscribe"]>[0]
    >();
    const subscribe: TerminalManager.TerminalManager["Service"]["subscribe"] = (listener) =>
      Effect.sync(() => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      });
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
      platform,
      stores,
      sink,
      importer,
      Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedSome(project) }),
      Layer.mock(TerminalManager.TerminalManager)({ openCommand, subscribe }),
      Layer.mock(ProjectFileActionApprovals.ProjectFileActionApprovals)({
        automationConfig: () => Effect.succeed({ source: "styal.json", actions: [fileSetup] }),
      }),
      Layer.mock(WorkspacePortAllocator.WorkspacePortAllocator)({
        getBasePort: () => Effect.succeed(options.portsExhausted ? null : 20_000),
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
      const runInput = {
        threadId,
        projectId,
        worktreePath: options.worktreePath ?? "/synthetic/repo-worktree",
      };
      if (options.stripped) yield* service.markStripped(runInput.worktreePath, projectId);
      const initial = yield* service.runForThread(runInput);
      let waitingId: string | undefined;
      if (options.approveAfterWaiting) {
        const waiting = (yield* projections.getThreadProjection(threadId)).turnItems.find(
          (item) => item.type === "command_execution",
        );
        waitingId = waiting?.id;
        const denied = yield* service
          .runPending({ threadId, turnItemId: TurnItemId.make(waitingId!) })
          .pipe(Effect.flip);
        assert.equal(denied.reason, "run-failed");
        assert.equal(openCommand.mock.calls.length, 0);
        yield* (yield* ServerSettings.ServerSettingsService).updateSettings({
          projectFileActionApprovals: { [`project:${projectId}`]: { [fileSetup.id]: approval } },
        });
      }
      if (options.approveAfterWaiting) {
        // A shell's setup that the approved run's open then replaces.
        const replacedShell =
          options.sameThreadShell === "replaced" ? yield* service.setUpStripped(runInput) : null;
        const approved = service.runPending({ threadId, turnItemId: TurnItemId.make(waitingId!) });
        if (options.launch === undefined) yield* approved;
        else assert.equal((yield* Effect.flip(approved)).reason, "run-failed");
        const repeated = yield* service
          .runPending({ threadId, turnItemId: TurnItemId.make(waitingId!) })
          .pipe(Effect.flip);
        assert.equal(repeated.reason, "run-failed");
        assert.equal(openCommand.mock.calls.length, replacedShell === null ? 1 : 2);
        // A shell on the same thread sets up again on the terminal the approved run is using.
        const shell =
          options.sameThreadShell === "reuses" || options.sameThreadShell === "replaces"
            ? yield* service.setUpStripped(runInput)
            : null;
        if (options.sameThreadShell !== undefined) assert.isNotNull(shell ?? replacedShell);
        if (options.exitCode !== undefined) {
          // Pending until the approved run ends: at this exit, or when the shell's setup replaced it.
          if (options.sameThreadShell !== "replaced")
            assert.equal(
              yield* service.isStripped(runInput.worktreePath),
              options.stripped === true && options.sameThreadShell !== "replaces",
            );
          yield* Effect.forEach([...listeners], (listener) =>
            listener({
              type: "exited",
              threadId,
              terminalId: "setup-file-setup",
              exitCode: options.exitCode!,
              exitSignal: null,
            }),
          );
          if (shell !== null) yield* shell.completion;
          // The replaced setup ended when its process did, not with the approved run's exit.
          if (replacedShell !== null)
            assert.equal((yield* replacedShell.completion).exitCode, null);
        }
      }
      const result = initial;
      if (options.portsExhausted) yield* service.runForThread(runInput);
      const turnItems = (yield* projections.getThreadProjection(threadId)).turnItems;
      const rows = turnItems.filter((item) => item.type === "command_execution");
      const notices = turnItems.filter((item) => item.type === "system_notice");
      const stripped = yield* service.isStripped(runInput.worktreePath);
      return { result, rows, notices, openCommand, projectId, waitingId, stripped };
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

  it.effect.each([
    { exitCode: 0, stripped: false },
    { exitCode: 7, stripped: false },
    { exitCode: 0, stripped: true },
    { exitCode: 7, stripped: true },
    { exitCode: undefined, stripped: true, launch: "fails" as const },
    { exitCode: undefined, stripped: true, launch: "errors" as const },
    { exitCode: 7, stripped: true, sameThreadShell: "reuses" as const },
    { exitCode: 0, stripped: true, sameThreadShell: "replaces" as const },
    { exitCode: 7, stripped: true, sameThreadShell: "replaced" as const },
  ])(
    "resumes the approved file action in its waiting row with exit $exitCode (stripped: $stripped, launch: $launch, same-thread shell: $sameThreadShell)",
    ({ exitCode, stripped, launch, sameThreadShell }) =>
      Effect.gen(function* () {
        const { result, rows, openCommand, waitingId, ...after } = yield* runWith({
          suffix: "approved",
          localScripts: [],
          approved: false,
          approveAfterWaiting: true,
          stripped,
          ...(exitCode === undefined ? {} : { exitCode }),
          ...(launch === undefined ? {} : { launch }),
          ...(sameThreadShell === undefined ? {} : { sameThreadShell }),
        });
        // The approved run was the root's setup, so its end clears the pending record.
        assert.isFalse(after.stripped);
        assert.equal(result.status, "awaiting-approval");
        assert.equal(openCommand.mock.calls[0]?.[0].command, "./scripts/bootstrap.sh");
        // One exit of a shared process settles the approved row and the shell's row; a process
        // the shell's setup replaced stops the approved run instead.
        const exited = exitCode === 0 ? "completed" : "failed";
        assert.deepEqual(
          rows.map((row) => row.status),
          sameThreadShell === "replaces"
            ? ["interrupted", exited]
            : sameThreadShell === "replaced"
              ? [exited, "interrupted"]
              : sameThreadShell === "reuses"
                ? [exited, exited]
                : [exited],
        );
        const waiting = rows.find((row) => row.id === waitingId);
        assert.equal(
          waiting?.type === "command_execution" && waiting.exitCode,
          sameThreadShell === "replaces" ? undefined : exitCode,
        );
        assert.equal(
          waiting?.type === "command_execution" && waiting.setupScript?.awaitingApproval,
          undefined,
        );
      }),
  );

  it.effect(
    "Approve and run leases the canonical root of a worktree under a symlinked parent",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
        yield* fs.makeDirectory(path.join(dir, "real"));
        yield* fs.symlink(path.join(dir, "real"), path.join(dir, "link"));
        // Turn and terminal recovery lease this root, as cleanup does.
        const withWorkspaceLease = yield* makeWorkspaceLease.pipe(Effect.provide(platform));
        const events: Array<string> = [];
        let cleanup: Fiber.Fiber<number> | undefined;
        yield* runWith({
          suffix: "symlinked",
          localScripts: [],
          approved: false,
          approveAfterWaiting: true,
          stripped: true,
          worktreePath: path.join(dir, "link", "feature"),
          onOpenCommand: withWorkspaceLease(
            path.join(dir, "real", "feature"),
            Effect.sync(() => events.push("cleanup")),
          ).pipe(
            Effect.forkDetach({ startImmediately: true }),
            Effect.map((fiber) => {
              cleanup = fiber;
              events.push("setup opened");
            }),
          ),
        });
        yield* Fiber.join(cleanup!);
        assert.deepEqual(events, ["setup opened", "cleanup"]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("runs setup without ports and says so once when no range is free", () =>
    Effect.gen(function* () {
      const { result, notices, openCommand } = yield* runWith({
        suffix: "no-ports",
        localScripts: [],
        approved: true,
        portsExhausted: true,
      });
      assert.equal(result.status, "started");
      assert.equal(openCommand.mock.calls.length, 2);
      assert.equal(notices.length, 1);
      assert.match(
        notices[0]?.type === "system_notice" ? notices[0].message : "",
        /^No free development ports/,
      );
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
