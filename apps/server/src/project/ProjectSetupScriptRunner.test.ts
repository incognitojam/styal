import { describe, expect, it, vi } from "@effect/vitest";
import {
  type OrchestrationCommand,
  type OrchestrationProject,
  EventId,
  ProjectId,
  ThreadId,
  type TerminalEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProjectionThreadActivities from "../persistence/Services/ProjectionThreadActivities.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ProjectSetupScriptRunner from "./ProjectSetupScriptRunner.ts";

const isProjectSetupScriptOperationError = Schema.is(
  ProjectSetupScriptRunner.ProjectSetupScriptOperationError,
);

const makeProject = (scripts: OrchestrationProject["scripts"]): OrchestrationProject => ({
  id: ProjectId.make("project-1"),
  title: "Project",
  workspaceRoot: "/repo/project",
  defaultModelSelection: null,
  scripts,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
});

const makeProjectionSnapshotQueryLayer = (project: OrchestrationProject) =>
  Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
    getCommandReadModel: () => Effect.die("unused"),
    getSnapshot: () => Effect.die("unused"),
    getShellSnapshot: () => Effect.die("unused"),
    getArchivedShellSnapshot: () => Effect.die("unused"),
    getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 1 }),
    getCounts: () => Effect.die("unused"),
    getActiveProjectByWorkspaceRoot: (workspaceRoot) =>
      Effect.succeed(
        workspaceRoot === project.workspaceRoot ? Option.some(project) : Option.none(),
      ),
    getProjectShellById: (projectId) =>
      Effect.succeed(projectId === project.id ? Option.some(project) : Option.none()),
    getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
    getThreadCheckpointContext: () => Effect.die("unused"),
    getFullThreadDiffContext: () => Effect.die("unused"),
    getThreadShellById: () => Effect.die("unused"),
    getThreadDetailById: () => Effect.die("unused"),
    getThreadDetailSnapshot: () => Effect.die("unused"),
    searchThreads: () => Effect.succeed({ matches: [] }),
  });

const makeTerminalManagerLayer = (
  overrides: Pick<TerminalManager.TerminalManager["Service"], "openCommand"> &
    Partial<Pick<TerminalManager.TerminalManager["Service"], "subscribe">>,
) =>
  Layer.succeed(TerminalManager.TerminalManager, {
    ...overrides,
    open: () => Effect.die(new Error("unused")),
    attachStream: () => Effect.die(new Error("unused")),
    write: () => Effect.die(new Error("unused")),
    resize: () => Effect.void,
    clear: () => Effect.void,
    restart: () => Effect.die(new Error("unused")),
    close: () => Effect.void,
    subscribe: overrides.subscribe ?? (() => Effect.succeed(() => undefined)),
    subscribeMetadata: () => Effect.succeed(() => undefined),
  });

const testLayer = (
  project: OrchestrationProject,
  terminal: Pick<TerminalManager.TerminalManager["Service"], "openCommand"> &
    Partial<Pick<TerminalManager.TerminalManager["Service"], "subscribe">>,
  commands: OrchestrationCommand[] = [],
) =>
  ProjectSetupScriptRunner.layer.pipe(
    Layer.provideMerge(makeProjectionSnapshotQueryLayer(project)),
    Layer.provideMerge(makeTerminalManagerLayer(terminal)),
    Layer.provideMerge(
      Layer.succeed(OrchestrationEngine.OrchestrationEngineService, {
        dispatch: (command) =>
          Effect.sync(() => {
            commands.push(command);
            return { sequence: commands.length };
          }),
        readEvents: () => Stream.empty,
        streamDomainEvents: Stream.empty,
        latestSequence: Effect.succeed(0),
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(ProjectionThreadActivities.ProjectionThreadActivityRepository, {
        upsert: () => Effect.void,
        listByThreadId: () => Effect.succeed([]),
        listUnfinishedSetupRuns: () => Effect.succeed([]),
        deleteByThreadId: () => Effect.void,
      }),
    ),
  );

describe("ProjectSetupScriptRunner", () => {
  it("derives requested or started setup runs without a terminal outcome as unfinished", () => {
    const activity = (
      runId: string,
      kind: string,
      sequence: number,
    ): ProjectionThreadActivities.ProjectionThreadActivity => ({
      activityId: EventId.make(`activity-${sequence}`),
      threadId: ThreadId.make("thread-1"),
      turnId: null,
      tone: "info",
      kind,
      summary: kind,
      payload: {
        runId,
        scriptId: "setup",
        scriptName: "Setup",
        command: "bun install",
        terminalId: "setup-setup",
        worktreePath: "/repo/worktrees/a",
      },
      sequence,
      createdAt: `2026-01-01T00:00:0${sequence}.000Z`,
    });

    const runs = ProjectSetupScriptRunner.deriveUnfinishedSetupRuns([
      activity("requested-only-run", "setup-script.requested", 1),
      activity("finished-run", "setup-script.requested", 2),
      activity("finished-run", "setup-script.started", 3),
      activity("finished-run", "setup-script.completed", 4),
      activity("unfinished-run", "setup-script.requested", 5),
      activity("unfinished-run", "setup-script.started", 6),
    ]);

    expect(runs).toMatchObject([
      {
        runId: "requested-only-run",
        startedAt: "2026-01-01T00:00:01.000Z",
        startedActivityRecorded: false,
      },
      {
        runId: "unfinished-run",
        startedAt: "2026-01-01T00:00:06.000Z",
        startedActivityRecorded: true,
      },
    ]);
  });

  it.effect("returns no-script when no setup script exists", () => {
    const openCommand = vi.fn(() => Effect.die("unexpected open"));
    const project = makeProject([]);

    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const result = yield* runner.runForThread({
        threadId: "thread-1",
        projectId: "project-1",
        worktreePath: "/repo/worktrees/a",
      });

      expect(result).toEqual({ status: "no-script" });
      expect(openCommand).not.toHaveBeenCalled();
    }).pipe(Effect.provide(testLayer(project, { openCommand })));
  });

  it.effect("opens the deterministic setup terminal with the command as its PTY process", () => {
    const commands: OrchestrationCommand[] = [];
    const openCommand = vi.fn(() =>
      Effect.succeed({
        threadId: "thread-1",
        terminalId: "setup-setup",
        cwd: "/repo/worktrees/a",
        worktreePath: "/repo/worktrees/a",
        status: "running" as const,
        pid: 123,
        history: "",
        exitCode: null,
        exitSignal: null,
        label: "setup-setup",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const project = makeProject([
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure",
        runOnWorktreeCreate: true,
      },
    ]);

    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const result = yield* runner.runForThread({
        threadId: "thread-1",
        projectCwd: "/repo/project",
        worktreePath: "/repo/worktrees/a",
      });

      expect(result).toMatchObject({
        status: "started",
        scriptId: "setup",
        scriptName: "Setup",
        terminalId: "setup-setup",
        cwd: "/repo/worktrees/a",
      });
      expect(openCommand).toHaveBeenCalledWith({
        threadId: "thread-1",
        terminalId: "setup-setup",
        cwd: "/repo/worktrees/a",
        worktreePath: "/repo/worktrees/a",
        env: {
          T3CODE_PROJECT_ROOT: "/repo/project",
          T3CODE_WORKTREE_PATH: "/repo/worktrees/a",
        },
        command: "bun install",
      });
      expect(
        commands.flatMap((command) =>
          command.type === "thread.activity.append" ? [command.activity.kind] : [],
        ),
      ).toEqual(["setup-script.requested", "setup-script.started"]);
    }).pipe(Effect.provide(testLayer(project, { openCommand }, commands)));
  });

  it.effect("records setup command success and all interruptions as failure outcomes", () => {
    const commands: OrchestrationCommand[] = [];
    let terminalListener: ((event: TerminalEvent) => Effect.Effect<void>) | undefined;
    let exitDuringOpen: Extract<TerminalEvent, { type: "exited" }> | null = {
      type: "exited",
      threadId: "thread-1",
      terminalId: "setup-setup",
      exitCode: 7,
      exitSignal: null,
    };
    const project = makeProject([
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure",
        runOnWorktreeCreate: true,
      },
    ]);

    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const result = yield* runner.runForThread({
        threadId: "thread-1",
        projectId: "project-1",
        worktreePath: "/repo/worktrees/a",
      });
      expect(result.status).toBe("started");
      if (!terminalListener) throw new Error("terminal listener was not registered");
      exitDuringOpen = null;

      const activities = commands.flatMap((command) =>
        command.type === "thread.activity.append" ? [command.activity] : [],
      );
      expect(activities.map((activity) => activity.kind)).toEqual([
        "setup-script.requested",
        "setup-script.started",
        "setup-script.failed",
      ]);
      expect(activities.at(-1)?.payload).toMatchObject({
        outcome: "failed",
        failureReason: "command-exit",
        exitCode: 7,
        exitSignal: null,
        command: "bun install",
      });

      yield* runner.runForThread({
        threadId: "thread-1",
        projectId: "project-1",
        worktreePath: "/repo/worktrees/a",
      });
      yield* terminalListener({
        type: "exited",
        threadId: "thread-1",
        terminalId: "setup-setup",
        exitCode: 0,
        exitSignal: null,
      });
      yield* runner.runForThread({
        threadId: "thread-1",
        projectId: "project-1",
        worktreePath: "/repo/worktrees/a",
      });
      yield* terminalListener({
        type: "closed",
        threadId: "thread-1",
        terminalId: "setup-setup",
      });
      yield* runner.runForThread({
        threadId: "thread-1",
        projectId: "project-1",
        worktreePath: "/repo/worktrees/a",
      });
      yield* terminalListener({
        type: "restarted",
        threadId: "thread-1",
        terminalId: "setup-setup",
        snapshot: {
          threadId: "thread-1",
          terminalId: "setup-setup",
          cwd: "/repo/worktrees/a",
          worktreePath: "/repo/worktrees/a",
          status: "running",
          pid: 456,
          history: "",
          exitCode: null,
          exitSignal: null,
          label: "setup-setup",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      });

      const terminalOutcomes = commands.flatMap((command) =>
        command.type === "thread.activity.append" &&
        ["setup-script.completed", "setup-script.failed"].includes(command.activity.kind)
          ? [command.activity.kind]
          : [],
      );
      expect(terminalOutcomes).toEqual([
        "setup-script.failed",
        "setup-script.completed",
        "setup-script.failed",
        "setup-script.failed",
      ]);
      expect(
        commands
          .flatMap((command) =>
            command.type === "thread.activity.append" ? [command.activity] : [],
          )
          .at(-1)?.payload,
      ).toMatchObject({
        outcome: "failed",
        failureReason: "terminal-restarted",
      });
    }).pipe(
      Effect.provide(
        testLayer(
          project,
          {
            openCommand: () =>
              Effect.gen(function* () {
                if (exitDuringOpen && terminalListener) {
                  yield* terminalListener(exitDuringOpen);
                }
                return {
                  threadId: "thread-1",
                  terminalId: "setup-setup",
                  cwd: "/repo/worktrees/a",
                  worktreePath: "/repo/worktrees/a",
                  status: "running" as const,
                  pid: 123,
                  history: "",
                  exitCode: null,
                  exitSignal: null,
                  label: "setup-setup",
                  updatedAt: "2026-01-01T00:00:00.000Z",
                };
              }),
            subscribe: (listener) =>
              Effect.sync(() => {
                terminalListener = listener;
                return () => undefined;
              }),
          },
          commands,
        ),
      ),
    );
  });

  it.effect("keeps terminal failures as the exact cause of a structured operation error", () => {
    const commands: OrchestrationCommand[] = [];
    const rootCause = new Error("stat failed");
    const terminalError = new TerminalManager.TerminalCwdStatError({
      cwd: "/repo/worktrees/a",
      cause: rootCause,
    });
    const project = makeProject([
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure",
        runOnWorktreeCreate: true,
      },
    ]);

    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const error = yield* runner
        .runForThread({
          threadId: "thread-1",
          projectId: "project-1",
          worktreePath: "/repo/worktrees/a",
        })
        .pipe(Effect.flip);

      expect(isProjectSetupScriptOperationError(error)).toBe(true);
      if (isProjectSetupScriptOperationError(error)) {
        expect(error.operation).toBe("openTerminal");
        expect(error.threadId).toBe("thread-1");
        expect(error.projectId).toBe("project-1");
        expect(error.worktreePath).toBe("/repo/worktrees/a");
        expect(error.cause).toBe(terminalError);
        expect(terminalError.cause).toBe(rootCause);
      }
    }).pipe(
      Effect.provide(
        testLayer(
          project,
          {
            openCommand: () => Effect.fail(terminalError),
          },
          commands,
        ),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(
            commands.flatMap((command) =>
              command.type === "thread.activity.append" ? [command.activity.kind] : [],
            ),
          ).toEqual(["setup-script.requested", "setup-script.failed"]);
        }),
      ),
    );
  });
});
