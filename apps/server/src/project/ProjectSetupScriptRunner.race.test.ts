import * as FileSystem from "effect/FileSystem";
// @effect-diagnostics nodeBuiltinImport:off -- Real Git fixtures exercise repository scope and completion evidence.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as AnalyticsService from "../telemetry/AnalyticsService.ts";
import { assert, it, vi } from "@effect/vitest";
import { EventId, ProjectId, ThreadId } from "@t3tools/contracts";
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

it.effect.each(["late-cancel", "late-marker", "cancel-first", "new-attempt"] as const)(
  "keeps setup outcomes and completion markers consistent: %s",
  (scenario) => {
    const scratch = NodePath.resolve(import.meta.dirname, "../../../../.scratch");
    NodeFS.mkdirSync(scratch, { recursive: true });
    const root = NodeFS.mkdtempSync(NodePath.join(scratch, "setup-recovery-"));
    const repo = NodePath.join(root, "repo");
    const worktree = NodePath.join(root, "worktree");
    const completionMarker = NodePath.join(worktree, ".styal/setup-completed");
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
    const listeners = new Set<
      Parameters<TerminalManager.TerminalManager["Service"]["subscribe"]>[0]
    >();
    let beforeMarkerWrite = Effect.void;
    const openCommand = vi.fn(
      (input: Parameters<TerminalManager.TerminalManager["Service"]["openCommand"]>[0]) =>
        Effect.gen(function* () {
          assert.isFalse(NodeFS.existsSync(completionMarker));
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
      Layer.provide(
        Layer.mergeAll(
          NodeServices.layer,
          Layer.effect(
            FileSystem.FileSystem,
            Effect.map(FileSystem.FileSystem, (fs) => ({
              ...fs,
              writeFileString: (...args) =>
                Effect.andThen(beforeMarkerWrite, fs.writeFileString(...args)),
            })),
          ).pipe(Layer.provide(NodeServices.layer)),
        ),
      ),
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
      const result = yield* service.runForThread({
        threadId,
        projectId,
        worktreePath: worktree,
        observeCompletion: {},
      });
      assert.equal(result.status, "started");
      if (result.status !== "started") return;
      const running = (yield* projections.getThreadProjection(threadId)).turnItems.find(
        (item) => item.type === "command_execution",
      );
      assert.equal(running?.status, "running");
      assert.equal(
        running?.type === "command_execution" && running.setupScript?.scriptName,
        "Install dependencies",
      );

      if (running?.type !== "command_execution") return assert.fail("setup absent");
      const markerReady = yield* Deferred.make<void>();
      const allowMarker = yield* Deferred.make<void>();
      if (scenario === "late-marker" || scenario === "new-attempt")
        beforeMarkerWrite = Deferred.succeed(markerReady, undefined).pipe(
          Effect.andThen(Deferred.await(allowMarker)),
        );
      const finish = Effect.forEach([...listeners], (listener) =>
        listener({
          type: "exited",
          threadId,
          terminalId: result.terminalId,
          exitCode: 0,
          exitSignal: null,
        }),
      );
      const cancel = () =>
        Effect.gen(function* () {
          yield* (yield* EventSink.EventSinkV2).write({
            events: [
              {
                id: EventId.make("review-stale-shutdown-cancel"),
                type: "turn-item.updated",
                threadId,
                occurredAt: yield* DateTime.now,
                payload: { ...running, status: "cancelled" },
              },
            ],
          });
        });
      if (scenario === "cancel-first") yield* cancel();
      const fiber = yield* finish.pipe(Effect.forkChild);
      if (scenario === "late-marker" || scenario === "new-attempt")
        yield* Deferred.await(markerReady);
      else yield* Fiber.join(fiber);
      if (scenario === "new-attempt") {
        const next = yield* service.runForThread({ threadId, projectId, worktreePath: worktree });
        assert.equal(next.status, "started");
      } else if (scenario !== "cancel-first") yield* cancel();
      if (scenario === "late-marker" || scenario === "new-attempt") {
        yield* Deferred.succeed(allowMarker, undefined);
        yield* Fiber.join(fiber);
      }
      const expected =
        scenario === "cancel-first"
          ? "interrupted"
          : scenario === "new-attempt"
            ? "pending"
            : "succeeded";
      assert.equal((yield* state())[0]!.status, expected);
      assert.equal(NodeFS.existsSync(completionMarker), expected === "succeeded");
      const projected = (yield* projections.getThreadProjection(threadId)).turnItems.find(
        (item) => item.id === running.id,
      );
      assert.equal(projected?.status, scenario === "cancel-first" ? "cancelled" : "completed");
    }).pipe(
      Effect.provide(Layer.mergeAll(dependencies, runner)),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
    );
  },
);
