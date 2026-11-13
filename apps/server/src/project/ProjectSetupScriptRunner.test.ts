// @effect-diagnostics nodeBuiltinImport:off -- Real Git fixtures exercise repository scope and completion evidence.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as AnalyticsService from "../telemetry/AnalyticsService.ts";
import { assert, describe, it, vi } from "@effect/vitest";
import { EventId, ProjectId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as TestClock from "effect/testing/TestClock";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
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
import * as WorkspacePortAllocator from "../workspace/WorkspacePortAllocator.ts";
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

it.effect(
  "recovers missing completion evidence once, binds it to the action, and retains failures",
  () => {
    const scratch = NodePath.resolve(import.meta.dirname, "../../../../.scratch");
    NodeFS.mkdirSync(scratch, { recursive: true });
    const root = NodeFS.mkdtempSync(NodePath.join(scratch, "setup-recovery-"));
    const repo = NodePath.join(root, "repo");
    const worktree = NodePath.join(root, "worktree");
    const worktreeAlias = NodePath.join(root, "worktree-alias");
    NodeFS.mkdirSync(repo);
    const git = (...args: string[]) => NodeChildProcess.execFileSync("git", ["-C", repo, ...args]);
    git("init");
    git(
      "-c",
      "user.name=Example",
      "-c",
      "user.email=example@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "init",
    );
    git("worktree", "add", "-b", "feature", worktree);
    NodeFS.symlinkSync(worktree, worktreeAlias, "junction");
    const listeners = new Set<
      Parameters<TerminalManager.TerminalManager["Service"]["subscribe"]>[0]
    >();
    let beforeOpen = Effect.void;
    const openCommand = vi.fn(
      (input: Parameters<TerminalManager.TerminalManager["Service"]["openCommand"]>[0]) =>
        Effect.gen(function* () {
          yield* input.threadId === threadId ? beforeOpen : Effect.void;
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
      workspaceRoot: repo,
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
    const automationConfig = vi.fn(() => Effect.succeed(null));
    const getProject = vi.fn(() => Effect.succeedSome(project));
    const dependencies = Layer.mergeAll(
      stores,
      sink,
      importer,
      ProjectionMaintenance.layer.pipe(Layer.provide(stores)),
      Layer.mock(ProjectService.ProjectService)({ getById: getProject }),
      Layer.mock(TerminalManager.TerminalManager)({ openCommand, subscribe }),
      reservedPorts,
      Layer.mock(ProjectFileActionApprovals.ProjectFileActionApprovals)({
        automationConfig,
      }),
      ServerSettings.layerTest(),
    );
    const runner = ProjectSetupScriptRunner.layer.pipe(
      Layer.provide(NodeServices.layer),
      Layer.provide(AnalyticsService.AnalyticsService.layerTest),
      Layer.provide(dependencies),
    );
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES (${projectId}, 'Setup', '/synthetic/repo', '[]', ${project.createdAt}, ${project.updatedAt})`;
      yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, runtime_mode, interaction_mode, created_at, updated_at)
      VALUES (${threadId}, ${projectId}, 'Setup', 'full-access', 'default', ${project.createdAt}, ${project.updatedAt})`;
      yield* (yield* LegacyImporter.LegacyV1ThreadImporter).reconcileShells;
      const service = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const state = () =>
        sql<{
          readonly turn_item_id: string;
          readonly thread_id: string;
          readonly action_id: string;
          readonly command: string;
          readonly status: string;
          readonly evidence_version: number | null;
          readonly device: string | null;
          readonly inode: string | null;
          readonly git_directory: string | null;
          readonly request_sequence: number;
        }>`SELECT * FROM worktree_setup_state WHERE worktree_path = ${NodeFS.realpathSync(worktree)}`;
      const assertState = (owner: ThreadId, runId: string, expected: string) =>
        Effect.gen(function* () {
          const row = (yield* state())[0]!;
          const item = (yield* projections.getThreadProjection(owner)).turnItems.find(
            (item) => item.type === "command_execution" && item.setupScript?.runId === runId,
          );
          assert.equal(row.turn_item_id, item?.id);
          assert.equal(row.thread_id, owner);
          assert.equal(row.status, expected);
          assert.equal(
            item?.status === "completed"
              ? "succeeded"
              : item?.status === "running"
                ? "pending"
                : item?.status,
            expected,
          );
          const request = yield* sql<{
            readonly sequence: number;
          }>`SELECT sequence FROM orchestration_events WHERE event_id = ${`setup:${runId}:setup-script.requested`}`;
          if (request[0]) assert.equal(row.request_sequence, request[0].sequence);
        });
      assert.deepEqual(yield* state(), []);
      const output: string[] = [];
      assert.equal(
        (yield* service.runForThread({
          threadId,
          projectId,
          worktreePath: worktree,
          recoverIfEvidenceMissing: true,
        })).status,
        "no-script",
      );
      const result = yield* service.runForThread({
        threadId,
        projectId,
        worktreePath: worktree,
        observeCompletion: {
          onOutputLine: (line) =>
            Effect.sync(() => {
              output.push(line);
            }),
        },
      });
      assert.equal(result.status, "started");
      if (result.status !== "started") return;
      yield* assertState(threadId, result.runId, "pending");
      assert.equal(result.scriptName, "Install dependencies");
      assert.equal(openCommand.mock.calls[0]?.[0].command, "vp install");
      assert.deepEqual(openCommand.mock.calls[0]?.[0].env, {
        STYAL_PROJECT_ROOT: repo,
        STYAL_WORKTREE_PATH: worktree,
        T3CODE_PROJECT_ROOT: repo,
        T3CODE_WORKTREE_PATH: worktree,
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
      yield* assertState(threadId, result.runId, "succeeded");
      const beforeRejected = yield* state();
      const beforeEvents = yield* sql`SELECT COUNT(*) AS count FROM orchestration_events`;
      const beforeProjections =
        yield* sql`SELECT COUNT(*) AS count FROM orchestration_v2_projection_turn_items`;
      const beforeCommands = openCommand.mock.calls.length;
      yield* sql`CREATE TRIGGER reject_setup_state BEFORE INSERT ON worktree_setup_state BEGIN SELECT RAISE(ABORT, 'synthetic state write failure'); END`;
      assert.equal(
        (yield* service
          .runForThread({ threadId, projectId, worktreePath: worktree })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      assert.deepEqual(yield* state(), beforeRejected);
      assert.deepEqual(
        yield* sql`SELECT COUNT(*) AS count FROM orchestration_events`,
        beforeEvents,
      );
      assert.deepEqual(
        yield* sql`SELECT COUNT(*) AS count FROM orchestration_v2_projection_turn_items`,
        beforeProjections,
      );
      assert.equal(openCommand.mock.calls.length, beforeCommands);
      yield* sql`DROP TRIGGER reject_setup_state`;

      const otherThreadId = ThreadId.make("thread:shared-worktree");
      yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, runtime_mode, interaction_mode, created_at, updated_at)
        VALUES (${otherThreadId}, ${projectId}, 'Shared', 'full-access', 'default', ${project.createdAt}, ${project.updatedAt})`;
      yield* (yield* LegacyImporter.LegacyV1ThreadImporter).reconcileShells;
      const otherSetup = yield* service.runForThread({
        threadId: otherThreadId,
        projectId,
        worktreePath: worktreeAlias,
        observeCompletion: {},
      });
      if (otherSetup.status !== "started") return assert.fail("shared setup did not start");
      const exitOther = () =>
        Effect.forEach(
          [...listeners],
          (listener) =>
            listener({
              type: "exited",
              threadId: otherThreadId,
              terminalId: otherSetup.terminalId,
              exitCode: 0,
              exitSignal: null,
            }),
          { discard: true },
        );
      yield* exitOther();
      yield* otherSetup.completion!;
      const aliasSetup = (yield* projections.getThreadProjection(otherThreadId)).turnItems.find(
        (item) => item.type === "command_execution" && item.setupScript?.runId === otherSetup.runId,
      );
      assert.equal(
        aliasSetup?.type === "command_execution" && aliasSetup.setupScript?.worktreePath,
        NodeFS.realpathSync(worktree),
      );
      const preservedState = yield* state();
      const pruning = Layer.mergeAll(
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: { T3CODE_EVENT_PRUNING: "1" } })),
      );
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      yield* maintenance.pruneEventStore().pipe(Effect.provide(pruning));
      yield* TestClock.adjust("1 day");
      assert.isAbove(
        (yield* maintenance.pruneEventStore().pipe(Effect.provide(pruning))).deletedEventCount,
        0,
      );
      assert.deepEqual(
        yield* sql`SELECT event_id FROM orchestration_events WHERE event_id = ${`setup:${otherSetup.runId}:setup-script.requested`}`,
        [],
      );
      assert.deepEqual(yield* state(), preservedState);
      const recoverOther = () =>
        service.runForThread({
          threadId: otherThreadId,
          projectId,
          worktreePath: worktreeAlias,
          recoverIfEvidenceMissing: true,
          observeCompletion: {},
        });
      const recover = () =>
        service.runForThread({
          threadId,
          projectId,
          worktreePath: worktree,
          recoverIfEvidenceMissing: true,
          observeCompletion: {},
        });
      const exit = (terminalId: string, exitCode: number, exitSignal: number | null = null) =>
        Effect.forEach(
          [...listeners],
          (listener) => listener({ type: "exited", threadId, terminalId, exitCode, exitSignal }),
          { discard: true },
        );
      assert.ok(
        NodeFS.readFileSync(NodePath.join(worktree, ".styal/setup-completed"), "utf8").includes(
          "vp install",
        ),
      );
      const projectReads = getProject.mock.calls.length;
      const configReads = automationConfig.mock.calls.length;
      assert.equal((yield* recover()).status, "no-script");
      assert.equal(getProject.mock.calls.length, projectReads);
      assert.equal(automationConfig.mock.calls.length, configReads);
      NodeFS.rmSync(NodePath.join(worktree, ".styal/setup-completed"));
      NodeFS.writeFileSync(NodePath.join(worktree, ".styal/setup-failed"), "");
      assert.equal((yield* recover()).status, "no-script");
      NodeFS.rmSync(NodePath.join(worktree, ".styal/setup-failed"));
      NodeFS.writeFileSync(NodePath.join(worktree, ".styal/setup-running"), String(process.pid));
      assert.equal((yield* recover()).status, "no-script");
      NodeFS.rmSync(NodePath.join(worktree, ".styal/setup-running"));
      const launchEntered = yield* Deferred.make<void>();
      const releaseLaunch = yield* Deferred.make<void>();
      beforeOpen = Deferred.succeed(launchEntered, undefined).pipe(
        Effect.andThen(Deferred.await(releaseLaunch)),
        Effect.asVoid,
      );
      const launching = yield* recover().pipe(Effect.forkChild);
      yield* Deferred.await(launchEntered);
      assert.equal((yield* recoverOther()).status, "no-script");
      yield* Deferred.succeed(releaseLaunch, undefined);
      const recovered = yield* Fiber.join(launching);
      beforeOpen = Effect.void;
      assert.equal(recovered.status, "started");
      if (recovered.status !== "started") return;
      assert.equal((yield* recover()).status, "no-script");
      if (aliasSetup?.type !== "command_execution")
        return assert.fail("initial sharing setup row missing");
      yield* (yield* EventSink.EventSinkV2).write({
        events: [
          {
            id: EventId.make("late-setup-outcome"),
            type: "turn-item.updated",
            threadId: otherThreadId,
            occurredAt: yield* DateTime.now,
            payload: aliasSetup,
          },
        ],
      });
      yield* assertState(threadId, recovered.runId, "pending");
      const releaseInstaller = yield* Deferred.make<void>();
      const installer = yield* Deferred.await(releaseInstaller).pipe(
        Effect.andThen(exit(recovered.terminalId, 0)),
        Effect.forkChild,
      );
      assert.equal((yield* recoverOther()).status, "no-script");
      yield* Deferred.succeed(releaseInstaller, undefined);
      yield* Fiber.join(installer);
      yield* recovered.completion!;
      NodeFS.rmSync(NodePath.join(worktree, ".styal/setup-completed"));
      const otherRecovered = yield* recoverOther();
      if (otherRecovered.status !== "started")
        return assert.fail("shared recovery stayed suppressed after exit");
      yield* exitOther();
      yield* otherRecovered.completion!;
      assert.equal((yield* recover()).status, "no-script");
      project.scripts[0]!.command = "echo markerless";
      NodeFS.rmSync(NodePath.join(worktree, ".styal/setup-completed"));
      assert.equal((yield* recover()).status, "no-script");
      project.scripts[0]!.command = "vp install";
      const savedState = (yield* state())[0]!;
      for (const field of ["device", "inode", "git_directory"] as const) {
        yield* sql.unsafe(`UPDATE worktree_setup_state SET ${field} = ? WHERE worktree_path = ?`, [
          "different-checkout",
          NodeFS.realpathSync(worktree),
        ]);
        assert.equal((yield* recoverOther()).status, "no-script");
        yield* sql`UPDATE worktree_setup_state SET device = ${savedState.device}, inode = ${savedState.inode}, git_directory = ${savedState.git_directory} WHERE worktree_path = ${worktree}`;
      }
      yield* sql`UPDATE worktree_setup_state SET evidence_version = 1 WHERE worktree_path = ${worktree}`;
      assert.equal((yield* recoverOther()).status, "no-script");
      yield* sql`UPDATE worktree_setup_state SET evidence_version = 2 WHERE worktree_path = ${worktree}`;
      git("worktree", "move", worktree, NodePath.join(root, "previous-worktree"));
      git("worktree", "add", "-b", "replacement", worktree);
      assert.equal((yield* recoverOther()).status, "no-script");
      const recreatedSetup = yield* service.runForThread({
        threadId,
        projectId,
        worktreePath: worktree,
        observeCompletion: {},
      });
      if (recreatedSetup.status !== "started") return assert.fail("recreated setup did not start");
      yield* exit(recreatedSetup.terminalId, 0);
      yield* recreatedSetup.completion!;
      for (const { exitCode, exitSignal } of [
        { exitCode: 2, exitSignal: null },
        { exitCode: 0, exitSignal: 15 },
      ]) {
        NodeFS.rmSync(NodePath.join(worktree, ".styal/setup-completed"), { force: true });
        const failed =
          exitSignal === null
            ? yield* recover()
            : yield* service.runForThread({
                threadId,
                projectId,
                worktreePath: worktree,
                observeCompletion: {},
              });
        if (failed.status !== "started") return assert.fail("setup did not start");
        yield* exit(failed.terminalId, exitCode, exitSignal);
        assert.deepEqual(yield* failed.completion!, { exitCode, exitSignal, durationMs: 0 });
        const failure = (yield* projections.getThreadProjection(threadId)).turnItems.find(
          (item) => item.type === "command_execution" && item.setupScript?.runId === failed.runId,
        );
        assert.equal(failure?.status, "failed");
        yield* assertState(threadId, failed.runId, "failed");
        assert.equal(failure?.type === "command_execution" && failure.exitCode, exitCode);
        assert.equal((yield* recover()).status, "no-script");
        assert.equal((yield* recoverOther()).status, "no-script");
      }
      const stopped = yield* service.runForThread({
        threadId,
        projectId,
        worktreePath: worktree,
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
      yield* assertState(threadId, stopped.runId, "interrupted");
      const guarded = yield* service.runForThread({
        threadId,
        projectId,
        worktreePath: project.workspaceRoot,
      });
      assert.equal(guarded.status, "not-a-worktree");
      for (const owner of [threadId, otherThreadId]) {
        const setup = yield* service.runForThread({
          threadId: owner,
          projectId,
          worktreePath: worktree,
          observeCompletion: {},
        });
        if (setup.status !== "started") return assert.fail("initial setup did not start");
        yield* Effect.forEach(
          [...listeners],
          (listener) =>
            listener({
              type: "exited",
              threadId: owner,
              terminalId: setup.terminalId,
              exitCode: 0,
              exitSignal: null,
            }),
          { discard: true },
        );
        yield* setup.completion!;
      }
      NodeFS.rmSync(NodePath.join(worktree, ".styal/setup-completed"));
      const beforeRestart = yield* recover();
      if (beforeRestart.status !== "started")
        return assert.fail("recovery did not start before restart");
      listeners.clear();
      const persistedInterruption = yield* Deferred.make<void>();
      const eventSink = yield* EventSink.EventSinkV2;
      const restarted = yield* ProjectSetupScriptRunner.make.pipe(
        Effect.provideService(EventSink.EventSinkV2, {
          ...eventSink,
          write: (input) =>
            eventSink
              .write(input)
              .pipe(
                Effect.tap(() =>
                  input.events.some(
                    (event) =>
                      event.type === "turn-item.updated" &&
                      event.payload.id === `setup:${beforeRestart.runId}` &&
                      event.payload.status === "interrupted",
                  )
                    ? Deferred.succeed(persistedInterruption, undefined)
                    : Effect.void,
                ),
              ),
        }),
        Effect.provide(
          Layer.mergeAll(NodeServices.layer, AnalyticsService.AnalyticsService.layerTest),
        ),
      );
      yield* Deferred.await(persistedInterruption);
      yield* assertState(threadId, beforeRestart.runId, "interrupted");
      const blockedState = yield* state();
      yield* TestClock.adjust("1 day");
      yield* maintenance.pruneEventStore().pipe(Effect.provide(pruning));
      yield* TestClock.adjust("1 day");
      yield* maintenance.pruneEventStore().pipe(Effect.provide(pruning));
      assert.deepEqual(
        yield* sql`SELECT event_id FROM orchestration_events WHERE event_id = ${`setup:${beforeRestart.runId}:setup-script.requested`}`,
        [],
      );
      assert.deepEqual(yield* state(), blockedState);
      const launchesBeforeRetry = openCommand.mock.calls.length;
      for (const owner of [otherThreadId, threadId]) {
        assert.equal(
          (yield* restarted.runForThread({
            threadId: owner,
            projectId,
            worktreePath: worktree,
            recoverIfEvidenceMissing: true,
          })).status,
          "no-script",
        );
      }
      assert.equal(openCommand.mock.calls.length, launchesBeforeRetry);
    }).pipe(
      Effect.provide(Layer.mergeAll(dependencies, runner)),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
    );
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
      reservedPorts,
      Layer.mock(ProjectFileActionApprovals.ProjectFileActionApprovals)({
        automationConfig: () => Effect.succeed(null),
      }),
      ServerSettings.layerTest(),
    );
    const runner = ProjectSetupScriptRunner.layer.pipe(
      Layer.provide(NodeServices.layer),
      Layer.provide(AnalyticsService.AnalyticsService.layerTest),
      Layer.provide(dependencies),
    );
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
    readonly exitCode?: number;
    readonly portsExhausted?: boolean;
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
    const runner = ProjectSetupScriptRunner.layer.pipe(
      Layer.provide(NodeServices.layer),
      Layer.provide(AnalyticsService.AnalyticsService.layerTest),
      Layer.provide(dependencies),
    );
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES (${projectId}, 'File', '/synthetic/repo', '[]', ${project.createdAt}, ${project.updatedAt})`;
      yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, runtime_mode, interaction_mode, created_at, updated_at)
      VALUES (${threadId}, ${projectId}, 'File', 'full-access', 'default', ${project.createdAt}, ${project.updatedAt})`;
      yield* (yield* LegacyImporter.LegacyV1ThreadImporter).reconcileShells;
      const service = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const runInput = { threadId, projectId, worktreePath: "/synthetic/repo-worktree" };
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
        yield* service.runPending({ threadId, turnItemId: TurnItemId.make(waitingId!) });
        const repeated = yield* service
          .runPending({ threadId, turnItemId: TurnItemId.make(waitingId!) })
          .pipe(Effect.flip);
        assert.equal(repeated.reason, "run-failed");
        assert.equal(openCommand.mock.calls.length, 1);
        if (options.exitCode !== undefined) {
          yield* Effect.forEach([...listeners], (listener) =>
            listener({
              type: "exited",
              threadId,
              terminalId: "setup-file-setup",
              exitCode: options.exitCode!,
              exitSignal: null,
            }),
          );
        }
      }
      const result = initial;
      if (options.portsExhausted) yield* service.runForThread(runInput);
      const turnItems = (yield* projections.getThreadProjection(threadId)).turnItems;
      const rows = turnItems.filter((item) => item.type === "command_execution");
      const notices = turnItems.filter((item) => item.type === "system_notice");
      return { result, rows, notices, openCommand, projectId, waitingId };
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

  it.effect.each([0, 7])(
    "resumes the approved file action in its waiting row with exit %s",
    (exitCode) =>
      Effect.gen(function* () {
        const { result, rows, openCommand, waitingId } = yield* runWith({
          suffix: "approved",
          localScripts: [],
          approved: false,
          approveAfterWaiting: true,
          exitCode,
        });
        assert.equal(result.status, "awaiting-approval");
        assert.equal(openCommand.mock.calls[0]?.[0].command, "./scripts/bootstrap.sh");
        assert.equal(rows.length, 1);
        assert.equal(rows[0]?.id, waitingId);
        assert.equal(rows[0]?.status, exitCode === 0 ? "completed" : "failed");
        assert.equal(rows[0]?.type === "command_execution" && rows[0].exitCode, exitCode);
        assert.equal(
          rows[0]?.type === "command_execution" && rows[0].setupScript?.awaitingApproval,
          undefined,
        );
      }),
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
