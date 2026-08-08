import { CommandId, EventId, ProjectId, ThreadId } from "@t3tools/contracts";
import { projectScriptRuntimeEnv, setupProjectScript } from "@t3tools/shared/projectScripts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";

import {
  increment,
  metricAttributes,
  setupScriptDuration,
  setupScriptRunsTotal,
} from "../observability/Metrics.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProjectionThreadActivities from "../persistence/Services/ProjectionThreadActivities.ts";
import { forkParked } from "../serverActivation.ts";
import * as TerminalManager from "../terminal/Manager.ts";

type SetupRunOutcome =
  | {
      readonly outcome: "succeeded";
      readonly exitCode: number;
      readonly exitSignal: number | null;
    }
  | {
      readonly outcome: "failed";
      readonly reason:
        | "command-exit"
        | "launch-error"
        | "server-restarted"
        | "terminal-closed"
        | "terminal-error"
        | "terminal-restarted";
      readonly exitCode: number | null;
      readonly exitSignal: number | null;
      readonly detail?: string;
    };

const SetupRunActivityPayload = Schema.Struct({
  runId: Schema.String,
  scriptId: Schema.String,
  scriptName: Schema.String,
  command: Schema.String,
  terminalId: Schema.String,
  worktreePath: Schema.String,
});
const decodeSetupRunActivityPayload = Schema.decodeUnknownOption(SetupRunActivityPayload);

interface ActiveSetupRun {
  readonly runId: string;
  readonly threadId: string;
  readonly scriptId: string;
  readonly scriptName: string;
  readonly command: string;
  readonly terminalId: string;
  readonly worktreePath: string;
  readonly startedAt: string;
  readonly startedActivityRecorded: boolean;
  readonly pendingOutcome: SetupRunOutcome | null;
}

export function deriveUnfinishedSetupRuns(
  activities: ReadonlyArray<ProjectionThreadActivities.ProjectionThreadActivity>,
): ReadonlyArray<ActiveSetupRun> {
  const unfinished = new Map<string, ActiveSetupRun>();
  for (const activity of activities) {
    const payload = decodeSetupRunActivityPayload(activity.payload);
    if (Option.isNone(payload)) continue;
    const runId = payload.value.runId;
    if (activity.kind === "setup-script.started") {
      unfinished.set(runId, {
        ...payload.value,
        threadId: activity.threadId,
        startedAt: activity.createdAt,
        startedActivityRecorded: true,
        pendingOutcome: null,
      });
      continue;
    }
    unfinished.delete(runId);
  }
  return [...unfinished.values()];
}

export interface ProjectSetupScriptRunnerResultNoScript {
  readonly status: "no-script";
}

export interface ProjectSetupScriptRunnerResultStarted {
  readonly status: "started";
  readonly runId: string;
  readonly scriptId: string;
  readonly scriptName: string;
  readonly terminalId: string;
  readonly cwd: string;
}

export type ProjectSetupScriptRunnerResult =
  | ProjectSetupScriptRunnerResultNoScript
  | ProjectSetupScriptRunnerResultStarted;

export interface ProjectSetupScriptRunnerInput {
  readonly threadId: string;
  readonly projectId?: string;
  readonly projectCwd?: string;
  readonly worktreePath: string;
  readonly preferredTerminalId?: string;
}

export class ProjectSetupScriptOperationError extends Schema.TaggedErrorClass<ProjectSetupScriptOperationError>()(
  "ProjectSetupScriptOperationError",
  {
    threadId: Schema.String,
    projectId: Schema.optional(Schema.String),
    projectCwd: Schema.optional(Schema.String),
    worktreePath: Schema.String,
    operation: Schema.Literals(["resolveProject", "openTerminal"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Project setup script operation '${this.operation}' failed for thread '${this.threadId}' in '${this.worktreePath}'.`;
  }
}

export class ProjectSetupScriptProjectNotFoundError extends Schema.TaggedErrorClass<ProjectSetupScriptProjectNotFoundError>()(
  "ProjectSetupScriptProjectNotFoundError",
  {
    threadId: Schema.String,
    projectId: Schema.optional(Schema.String),
    projectCwd: Schema.optional(Schema.String),
    worktreePath: Schema.String,
  },
) {
  override get message(): string {
    return `Project was not found for setup script execution for thread '${this.threadId}' in '${this.worktreePath}'.`;
  }
}

export const ProjectSetupScriptRunnerError = Schema.Union([
  ProjectSetupScriptOperationError,
  ProjectSetupScriptProjectNotFoundError,
]);
export type ProjectSetupScriptRunnerError = typeof ProjectSetupScriptRunnerError.Type;

export class ProjectSetupScriptRunner extends Context.Service<
  ProjectSetupScriptRunner,
  {
    readonly runForThread: (
      input: ProjectSetupScriptRunnerInput,
    ) => Effect.Effect<ProjectSetupScriptRunnerResult, ProjectSetupScriptRunnerError>;
  }
>()("t3/project/ProjectSetupScriptRunner") {}

export const make = Effect.gen(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const terminalManager = yield* TerminalManager.TerminalManager;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const projectionThreadActivities =
    yield* ProjectionThreadActivities.ProjectionThreadActivityRepository;
  const activeRunsRef = yield* SynchronizedRef.make(new Map<string, ActiveSetupRun>());
  let nextRunSequence = 0;

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const terminalKey = (threadId: string, terminalId: string) => `${threadId}\0${terminalId}`;

  const appendActivity = Effect.fn("ProjectSetupScriptRunner.appendActivity")(function* (input: {
    readonly threadId: string;
    readonly runId: string;
    readonly kind: string;
    readonly summary: string;
    readonly tone: "info" | "error";
    readonly createdAt: string;
    readonly payload: Record<string, unknown>;
  }) {
    const activityId = EventId.make(`setup:${input.runId}:${input.kind}`);
    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make(`server:setup-script:${input.runId}:${input.kind}`),
      threadId: ThreadId.make(input.threadId),
      activity: {
        id: activityId,
        tone: input.tone,
        kind: input.kind,
        summary: input.summary,
        payload: input.payload,
        turnId: null,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  const recordOutcome = Effect.fn("ProjectSetupScriptRunner.recordOutcome")(function* (
    run: ActiveSetupRun,
    outcome: SetupRunOutcome,
  ) {
    const finishedAt = yield* nowIso;
    const durationMs = Math.max(0, Date.parse(finishedAt) - Date.parse(run.startedAt));
    const succeeded = outcome.outcome === "succeeded";
    const interrupted =
      outcome.outcome === "failed" &&
      (outcome.reason === "server-restarted" ||
        outcome.reason === "terminal-closed" ||
        outcome.reason === "terminal-restarted");
    yield* appendActivity({
      threadId: run.threadId,
      runId: run.runId,
      kind: succeeded ? "setup-script.completed" : "setup-script.failed",
      summary: succeeded
        ? "Setup script completed"
        : interrupted
          ? "Setup script stopped"
          : "Setup script failed",
      tone: succeeded ? "info" : "error",
      createdAt: finishedAt,
      payload: {
        runId: run.runId,
        scriptId: run.scriptId,
        scriptName: run.scriptName,
        command: run.command,
        terminalId: run.terminalId,
        worktreePath: run.worktreePath,
        outcome: outcome.outcome,
        ...(outcome.outcome === "failed" ? { failureReason: outcome.reason } : {}),
        exitCode: outcome.exitCode,
        exitSignal: outcome.exitSignal,
        durationMs,
        ...(outcome.outcome === "failed" && outcome.detail !== undefined
          ? { detail: outcome.detail }
          : {}),
      },
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to record setup script outcome", {
          threadId: run.threadId,
          runId: run.runId,
          outcome: outcome.outcome,
          cause,
        }),
      ),
    );
    yield* increment(setupScriptRunsTotal, { outcome: outcome.outcome });
    yield* Metric.update(
      Metric.withAttributes(setupScriptDuration, metricAttributes({ outcome: outcome.outcome })),
      Duration.millis(durationMs),
    );
  });

  const finishRun = Effect.fn("ProjectSetupScriptRunner.finishRun")(function* (
    threadId: string,
    terminalId: string,
    outcome: SetupRunOutcome,
  ) {
    const ready = yield* SynchronizedRef.modify(activeRunsRef, (runs) => {
      const key = terminalKey(threadId, terminalId);
      const run = runs.get(key);
      if (!run) return [Option.none<ActiveSetupRun>(), runs] as const;
      if (!run.startedActivityRecorded) {
        const next = new Map(runs);
        next.set(key, { ...run, pendingOutcome: outcome });
        return [Option.none<ActiveSetupRun>(), next] as const;
      }
      const next = new Map(runs);
      next.delete(key);
      return [Option.some(run), next] as const;
    });
    if (Option.isSome(ready)) {
      yield* recordOutcome(ready.value, outcome);
    }
  });

  const unsubscribe = yield* terminalManager.subscribe((event) => {
    switch (event.type) {
      case "exited":
        return finishRun(
          event.threadId,
          event.terminalId,
          event.exitCode === 0 && (event.exitSignal === null || event.exitSignal === 0)
            ? {
                outcome: "succeeded",
                exitCode: event.exitCode,
                exitSignal: event.exitSignal,
              }
            : {
                outcome: "failed",
                reason: "command-exit",
                exitCode: event.exitCode,
                exitSignal: event.exitSignal,
              },
        );
      case "closed":
        return finishRun(event.threadId, event.terminalId, {
          outcome: "failed",
          reason: "terminal-closed",
          exitCode: null,
          exitSignal: null,
        });
      case "error":
        return finishRun(event.threadId, event.terminalId, {
          outcome: "failed",
          reason: "terminal-error",
          exitCode: null,
          exitSignal: null,
          detail: event.message,
        });
      case "restarted":
        return finishRun(event.threadId, event.terminalId, {
          outcome: "failed",
          reason: "terminal-restarted",
          exitCode: null,
          exitSignal: null,
        });
      default:
        return Effect.void;
    }
  });
  yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

  const recoverInterruptedRuns = Effect.fn("ProjectSetupScriptRunner.recoverInterruptedRuns")(
    function* () {
      const activities = yield* projectionThreadActivities.listUnfinishedSetupRuns();
      yield* Effect.forEach(
        deriveUnfinishedSetupRuns(activities),
        (run) =>
          recordOutcome(run, {
            outcome: "failed",
            reason: "server-restarted",
            exitCode: null,
            exitSignal: null,
          }),
        { concurrency: 1, discard: true },
      );
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("failed to recover interrupted setup script runs", { cause }),
    ),
  );
  yield* forkParked(recoverInterruptedRuns());

  const runForThread: ProjectSetupScriptRunner["Service"]["runForThread"] = Effect.fn(
    "ProjectSetupScriptRunner.runForThread",
  )(function* (input) {
    const errorContext = {
      threadId: input.threadId,
      worktreePath: input.worktreePath,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.projectCwd === undefined ? {} : { projectCwd: input.projectCwd }),
    };
    const projectById = input.projectId
      ? yield* projectionSnapshotQuery.getProjectShellById(ProjectId.make(input.projectId)).pipe(
          Effect.map(Option.getOrUndefined),
          Effect.mapError(
            (cause) =>
              new ProjectSetupScriptOperationError({
                ...errorContext,
                operation: "resolveProject",
                cause,
              }),
          ),
        )
      : null;
    const project =
      projectById ??
      (input.projectCwd
        ? yield* projectionSnapshotQuery.getActiveProjectByWorkspaceRoot(input.projectCwd).pipe(
            Effect.map(Option.getOrUndefined),
            Effect.mapError(
              (cause) =>
                new ProjectSetupScriptOperationError({
                  ...errorContext,
                  operation: "resolveProject",
                  cause,
                }),
            ),
          )
        : null);

    if (!project) {
      return yield* new ProjectSetupScriptProjectNotFoundError(errorContext);
    }

    const script = setupProjectScript(project.scripts);
    if (!script) {
      return {
        status: "no-script",
      } as const;
    }

    const terminalId = input.preferredTerminalId ?? `setup-${script.id}`;
    const cwd = input.worktreePath;
    const requestedAt = yield* nowIso;
    nextRunSequence += 1;
    const runId = `${input.threadId}:${script.id}:${requestedAt}:${nextRunSequence}`;
    const env = projectScriptRuntimeEnv({
      project: { cwd: project.workspaceRoot },
      worktreePath: input.worktreePath,
    });

    const activeRun: ActiveSetupRun = {
      runId,
      threadId: input.threadId,
      scriptId: script.id,
      scriptName: script.name,
      command: script.command,
      terminalId,
      worktreePath: input.worktreePath,
      startedAt: requestedAt,
      startedActivityRecorded: false,
      pendingOutcome: null,
    };
    yield* SynchronizedRef.update(activeRunsRef, (runs) => {
      const next = new Map(runs);
      next.set(terminalKey(input.threadId, terminalId), activeRun);
      return next;
    });
    yield* appendActivity({
      threadId: input.threadId,
      runId,
      kind: "setup-script.requested",
      summary: "Starting setup script",
      tone: "info",
      createdAt: requestedAt,
      payload: {
        runId,
        scriptId: script.id,
        scriptName: script.name,
        command: script.command,
        terminalId,
        worktreePath: input.worktreePath,
      },
    }).pipe(Effect.ignoreCause({ log: true }));

    const terminal = yield* terminalManager
      .openCommand({
        threadId: input.threadId,
        terminalId,
        cwd,
        worktreePath: input.worktreePath,
        env,
        command: script.command,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProjectSetupScriptOperationError({
              ...errorContext,
              operation: "openTerminal",
              cause,
            }),
        ),
        Effect.tapError((error) =>
          SynchronizedRef.update(activeRunsRef, (runs) => {
            const next = new Map(runs);
            next.delete(terminalKey(input.threadId, terminalId));
            return next;
          }).pipe(
            Effect.andThen(
              recordOutcome(activeRun, {
                outcome: "failed",
                reason: "launch-error",
                exitCode: null,
                exitSignal: null,
                detail: error.message,
              }),
            ),
          ),
        ),
      );

    if (terminal.status === "error") {
      const startError = new ProjectSetupScriptOperationError({
        ...errorContext,
        operation: "openTerminal",
        cause: new Error(`Setup terminal '${terminalId}' failed to start.`),
      });
      yield* SynchronizedRef.update(activeRunsRef, (runs) => {
        const next = new Map(runs);
        next.delete(terminalKey(input.threadId, terminalId));
        return next;
      });
      yield* recordOutcome(activeRun, {
        outcome: "failed",
        reason: "launch-error",
        exitCode: null,
        exitSignal: null,
        detail: startError.message,
      });
      return yield* startError;
    }

    const startedAt = yield* nowIso;
    yield* appendActivity({
      threadId: input.threadId,
      runId,
      kind: "setup-script.started",
      summary: "Setup script started",
      tone: "info",
      createdAt: startedAt,
      payload: {
        runId,
        scriptId: script.id,
        scriptName: script.name,
        command: script.command,
        terminalId,
        worktreePath: input.worktreePath,
      },
    }).pipe(Effect.ignoreCause({ log: true }));

    const pendingOutcome = yield* SynchronizedRef.modify(activeRunsRef, (runs) => {
      const key = terminalKey(input.threadId, terminalId);
      const run = runs.get(key);
      if (!run) return [Option.none<readonly [ActiveSetupRun, SetupRunOutcome]>(), runs] as const;
      if (run.pendingOutcome) {
        const next = new Map(runs);
        next.delete(key);
        return [Option.some([run, run.pendingOutcome] as const), next] as const;
      }
      const next = new Map(runs);
      next.set(key, { ...run, startedActivityRecorded: true });
      return [Option.none<readonly [ActiveSetupRun, SetupRunOutcome]>(), next] as const;
    });
    if (Option.isSome(pendingOutcome)) {
      yield* recordOutcome(...pendingOutcome.value);
    }

    return {
      status: "started",
      runId,
      scriptId: script.id,
      scriptName: script.name,
      terminalId,
      cwd,
    } as const;
  });

  return ProjectSetupScriptRunner.of({ runForThread });
});

export const layer = Layer.effect(ProjectSetupScriptRunner, make);
