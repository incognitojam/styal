import { makeCheckoutRoot } from "../worktreeCleanup/Checkout.ts";
import { makeConsume } from "../worktreeCleanup/Stripped.ts";
import {
  EventId,
  ProjectFileActionApprovalError,
  linkOriginIsFenced,
  ProjectId,
  ProjectScriptIcon,
  ThreadId,
  TurnItemId,
  OrchestrationV2TurnItemJson,
  type ProjectScript,
} from "@t3tools/contracts";
import {
  isProjectCheckoutRun,
  isLifecycleScriptOutsideWorktree,
  projectScriptRuntimeEnv,
  resolveProjectActions,
  settleProjectScript,
  setupProjectScript,
} from "@t3tools/shared/projectScripts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
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
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as TurnItemPositions from "../orchestration-v2/TurnItemPositionStore.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectFileActionApprovals from "./ProjectFileActionApprovals.ts";
import * as ProjectService from "./ProjectService.ts";
import { forkParked } from "../serverActivation.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as WorkspacePortAllocator from "../workspace/WorkspacePortAllocator.ts";
import { makeWorkspaceLease } from "../workspace/workspaceLease.ts";

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
  scriptIcon: Schema.optionalKey(ProjectScriptIcon),
  command: Schema.String,
  terminalId: Schema.String,
  worktreePath: Schema.String,
  awaitingApproval: Schema.optionalKey(
    Schema.Struct({ projectId: ProjectId, actionId: Schema.String }),
  ),
});
const decodeSetupRunActivityPayload = Schema.decodeUnknownOption(SetupRunActivityPayload);
const decodeSetupRunActivityPayloadEffect = Schema.decodeUnknownEffect(SetupRunActivityPayload);
const decodeTurnItemJson = Schema.decodeEffect(Schema.fromJsonString(OrchestrationV2TurnItemJson));

type ProjectScriptTrigger = "setup" | "settle";

/** Settle runs use `settle-<scriptId>` terminals; everything else is a setup run. */
const triggerForTerminalId = (terminalId: string): ProjectScriptTrigger =>
  terminalId.startsWith("settle-") ? "settle" : "setup";

interface ActiveSetupRun {
  readonly runId: string;
  readonly threadId: string;
  readonly trigger: ProjectScriptTrigger;
  readonly scriptId: string;
  readonly scriptName: string;
  readonly scriptIcon?: ProjectScriptIcon;
  readonly command: string;
  readonly terminalId: string;
  readonly worktreePath: string;
  readonly startedAt: string;
  readonly startedActivityRecorded: boolean;
  readonly pendingOutcome: SetupRunOutcome | null;
  readonly clearsSetupRecord?: boolean;
}

function deriveUnfinishedSetupRuns(
  activities: ReadonlyArray<{
    readonly threadId: string;
    readonly kind: string;
    readonly payload: unknown;
    readonly createdAt: string;
  }>,
): ReadonlyArray<ActiveSetupRun> {
  const unfinished = new Map<string, ActiveSetupRun>();
  for (const activity of activities) {
    const payload = decodeSetupRunActivityPayload(activity.payload);
    if (Option.isNone(payload)) continue;
    const runId = payload.value.runId;
    if (activity.kind === "setup-script.requested" || activity.kind === "setup-script.started") {
      unfinished.set(runId, {
        ...payload.value,
        threadId: activity.threadId,
        trigger: triggerForTerminalId(payload.value.terminalId),
        startedAt: activity.createdAt,
        startedActivityRecorded: activity.kind === "setup-script.started",
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
  readonly scriptCommand: string;
  readonly terminalId: string;
  readonly cwd: string;
  readonly async: boolean;
  /**
   * Null exit code means the terminal closed, restarted or failed before the process exited.
   * Only present when `observeCompletion` was requested.
   */
  readonly completion?: Effect.Effect<ProjectSetupScriptCompletion>;
}

export interface ProjectSetupScriptCompletion {
  readonly exitCode: number | null;
  readonly exitSignal: number | null;
  readonly durationMs: number;
}

export interface ProjectSetupScriptOutputLine {
  readonly line: string;
}

export interface ProjectSetupScriptRunnerResultNotAWorktree {
  readonly status: "not-a-worktree";
  readonly scriptId: string;
  readonly scriptName: string;
}

/** A settle run is still going in the thread's settle terminal, so no second one starts. */
export interface ProjectSetupScriptRunnerResultAlreadyRunning {
  readonly status: "already-running";
  readonly scriptId: string;
  readonly scriptName: string;
  readonly terminalId: string;
}

/** A styal.json action asks for this role, but the user has not approved its command. */
export interface ProjectSetupScriptRunnerResultAwaitingApproval {
  readonly status: "awaiting-approval";
  readonly scriptId: string;
  readonly scriptName: string;
}

/**
 * A thread a link below full access started does not run this project's setup
 * script: the script is the user's own code, and such a link only grants T3's
 * tools (see `mcp/linkOrigin.ts`).
 */
export interface ProjectSetupScriptRunnerResultSkippedForLink {
  readonly status: "skipped-for-link";
}

export type ProjectSetupScriptRunnerResult =
  | ProjectSetupScriptRunnerResultNoScript
  | ProjectSetupScriptRunnerResultAwaitingApproval
  | ProjectSetupScriptRunnerResultNotAWorktree
  | ProjectSetupScriptRunnerResultAlreadyRunning
  | ProjectSetupScriptRunnerResultSkippedForLink
  | ProjectSetupScriptRunnerResultStarted;

export interface ProjectSetupScriptRunnerInput {
  /** Provider recovery already holds the lease while setup opens its terminal. */
  readonly workspaceLeaseHeld?: boolean;
  readonly threadId: string;
  readonly projectId?: string;
  readonly projectCwd?: string;
  readonly worktreePath: string;
  readonly trigger?: ProjectScriptTrigger;
  readonly project?: {
    readonly id: ProjectId;
    readonly workspaceRoot: string;
    readonly scripts: ReadonlyArray<ProjectScript>;
  };
  readonly preferredTerminalId?: string;
  readonly expectedActionId?: string;
  readonly resumeRunId?: string;
  /** Clear the worktree's pending setup record when this run's terminal reports its end. */
  readonly clearsSetupRecord?: boolean;
  /**
   * Report the script's exit through `completion`, and forward cleaned output
   * lines while it runs. The bootstrap flow uses this to drive the worktree
   * setup card.
   */
  readonly observeCompletion?: {
    readonly onOutputLine?: (line: string) => Effect.Effect<void>;
  };
}

export class ProjectSetupScriptOperationError extends Schema.TaggedError<ProjectSetupScriptOperationError>()(
  "ProjectSetupScriptOperationError",
  {
    threadId: Schema.String,
    projectId: Schema.optional(Schema.String),
    projectCwd: Schema.optional(Schema.String),
    worktreePath: Schema.String,
    operation: Schema.Literals(["readThread", "resolveProject", "readSettings", "openTerminal"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Project setup script operation '${this.operation}' failed for thread '${this.threadId}' in '${this.worktreePath}'.`;
  }
}

export class ProjectSetupScriptProjectNotFoundError extends Schema.TaggedError<ProjectSetupScriptProjectNotFoundError>()(
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
    readonly runPending: (input: {
      readonly threadId: ThreadId;
      readonly turnItemId: TurnItemId;
    }) => Effect.Effect<void, ProjectFileActionApprovalError>;
    readonly consumeStripped: (worktreePath: string) => Effect.Effect<boolean>;
    readonly isStripped: (worktreePath: string) => Effect.Effect<boolean>;
    readonly markStripped: (worktreePath: string, projectId: ProjectId) => Effect.Effect<void>;
    readonly runForThread: (
      input: ProjectSetupScriptRunnerInput,
    ) => Effect.Effect<ProjectSetupScriptRunnerResult, ProjectSetupScriptRunnerError>;
    /** Call with the worktree root's lease held. */
    readonly setUpStripped: (
      input: ProjectSetupScriptRunnerInput,
    ) => Effect.Effect<StrippedSetup | null, ProjectSetupScriptRunnerError>;
  }
>()("@styal/cli/project/ProjectSetupScriptRunner") {}

export interface StrippedSetup {
  readonly async: boolean;
  readonly completion: Effect.Effect<ProjectSetupScriptCompletion>;
}

/**
 * Runs approved setup while a worktree root's setup record is pending. Turn starts and terminals,
 * on any thread, join a run already going in that root instead of starting another. The record
 * clears when setup ends, not when setup awaits approval or the scope closes first, as at shutdown.
 */
export const makeSetUpStripped = Effect.fn("ProjectSetupScriptRunner.makeSetUpStripped")(function* (
  runner: Pick<
    ProjectSetupScriptRunner["Service"],
    "runForThread" | "isStripped" | "consumeStripped"
  >,
) {
  const scope = yield* Effect.scope;
  const inFlight = new Map<string, StrippedSetup>();
  return Effect.fn("ProjectSetupScriptRunner.setUpStripped")(
    function* (input: ProjectSetupScriptRunnerInput) {
      const root = input.worktreePath;
      const running = inFlight.get(root);
      if (running !== undefined) return running;
      if (!(yield* runner.isStripped(root))) return null;
      const setup = yield* runner
        .runForThread({ ...input, observeCompletion: {}, workspaceLeaseHeld: true })
        .pipe(Effect.tapError(() => runner.consumeStripped(root)));
      if (setup.status !== "started") {
        if (setup.status !== "awaiting-approval") yield* runner.consumeStripped(root);
        return null;
      }
      if (setup.completion === undefined) return null;
      const done = Deferred.makeUnsafe<ProjectSetupScriptCompletion>();
      const entry: StrippedSetup = { async: setup.async, completion: Deferred.await(done) };
      inFlight.set(root, entry);
      // Observed apart from any caller, so a caller that stops waiting leaves the run joinable.
      yield* setup.completion.pipe(
        Effect.tap(() => runner.consumeStripped(root)),
        Effect.onExit((exit) =>
          Effect.sync(() => inFlight.delete(root)).pipe(Effect.andThen(Deferred.done(done, exit))),
        ),
        Effect.interruptible,
        Effect.forkIn(scope),
      );
      return entry;
    },
    // Until setup's terminal exists, the caller's lease is all that keeps cleanup out of the root.
    Effect.uninterruptible,
  );
});

const OUTPUT_LINE_MAX_LENGTH = 400;
const PARTIAL_LINE_MAX_LENGTH = 4_096;

function stripTerminalControl(text: string): string {
  return text
    .replace(
      /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]/g,
      "",
    )
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

/** @public */
export const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ProjectionStore.ProjectionStoreV2;
  const terminalManager = yield* TerminalManager.TerminalManager;
  const eventSink = yield* EventSink.EventSinkV2;
  const positions = yield* TurnItemPositions.TurnItemPositionStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const consume = yield* makeConsume;
  const portAllocator = yield* WorkspacePortAllocator.WorkspacePortAllocator;
  // Runs that reuse one setup terminal's process, such as an approved run and a shell's setup, share it.
  const activeRunsRef = yield* SynchronizedRef.make(
    new Map<string, ReadonlyArray<ActiveSetupRun>>(),
  );
  const replaceRuns = (
    runs: ReadonlyMap<string, ReadonlyArray<ActiveSetupRun>>,
    key: string,
    update: (active: ReadonlyArray<ActiveSetupRun>) => ReadonlyArray<ActiveSetupRun>,
  ) => {
    const next = new Map(runs);
    const active = update(runs.get(key) ?? []);
    if (active.length === 0) next.delete(key);
    else next.set(key, active);
    return next;
  };
  // Runs this process started. Startup recovery runs alongside new runs and
  // must only close runs a previous server left behind.
  const ownRunIds = new Set<string>();
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
    const metadata = yield* decodeSetupRunActivityPayloadEffect(input.payload);
    const threadId = ThreadId.make(input.threadId);
    const id = TurnItemId.make(`setup:${input.runId}`);
    const rows = yield* sql<{ readonly payload_json: string }>`
      SELECT payload_json FROM orchestration_v2_projection_turn_items
      WHERE thread_id = ${threadId} AND turn_item_id = ${id}
    `;
    const previous =
      rows[0] === undefined ? undefined : yield* decodeTurnItemJson(rows[0].payload_json);
    const finished =
      input.kind === "setup-script.completed" || input.kind === "setup-script.failed";
    const stopped = ["server-restarted", "terminal-closed", "terminal-restarted"].includes(
      String(input.payload.failureReason),
    );
    const at = DateTime.makeUnsafe(input.createdAt);
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(`setup:${input.runId}:${input.kind}`),
          type: "turn-item.updated",
          threadId,
          occurredAt: at,
          payload: {
            id,
            threadId,
            runId: null,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: yield* positions.allocate({ threadId, turnItemId: id, runId: null }),
            type: "command_execution",
            title: metadata.scriptName,
            input: metadata.command,
            setupScript: {
              runId: metadata.runId,
              scriptId: metadata.scriptId,
              scriptName: metadata.scriptName,
              ...(metadata.scriptIcon === undefined ? {} : { scriptIcon: metadata.scriptIcon }),
              terminalId: metadata.terminalId,
              worktreePath: metadata.worktreePath,
              ...(metadata.awaitingApproval === undefined
                ? {}
                : { awaitingApproval: metadata.awaitingApproval }),
            },
            status:
              input.kind === "setup-script.completed"
                ? "completed"
                : finished
                  ? stopped
                    ? "interrupted"
                    : "failed"
                  : input.kind === "setup-script.started"
                    ? "running"
                    : input.kind === "setup-script.awaiting-approval"
                      ? // Not "waiting": nothing runs, so the thread must not look busy.
                        "idle"
                      : "pending",
            startedAt:
              previous?.startedAt == null || previous.status === "idle"
                ? at
                : DateTime.makeUnsafe(previous.startedAt),
            completedAt: finished ? at : null,
            updatedAt: at,
            ...(typeof input.payload.exitCode === "number"
              ? { exitCode: input.payload.exitCode }
              : {}),
            ...(typeof input.payload.detail === "string" ? { output: input.payload.detail } : {}),
          },
        },
      ],
    });
  });

  const isStripped = Effect.fn("ProjectSetupScriptRunner.isStripped")(function* (root: string) {
    const rows = yield* sql`SELECT 1 FROM worktree_stripped WHERE worktree_path = ${root}`;
    return rows.length > 0;
  }, Effect.orDie);
  const consumeStripped = Effect.fn("ProjectSetupScriptRunner.consumeStripped")((root: string) =>
    consume(root).pipe(Effect.orDie),
  );

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
        ...(run.scriptIcon ? { scriptIcon: run.scriptIcon } : {}),
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
    yield* increment(setupScriptRunsTotal, { outcome: outcome.outcome, trigger: run.trigger });
    yield* Metric.update(
      Metric.withAttributes(
        setupScriptDuration,
        metricAttributes({ outcome: outcome.outcome, trigger: run.trigger }),
      ),
      Duration.millis(durationMs),
    );
    if (run.clearsSetupRecord) yield* consumeStripped(run.worktreePath);
  });

  const finishRun = Effect.fn("ProjectSetupScriptRunner.finishRun")(function* (
    threadId: string,
    terminalId: string,
    outcome: SetupRunOutcome,
    // A new process comes from an opening run's own launch, so it ends only runs already started.
    endsOpening = true,
  ) {
    const ended = yield* SynchronizedRef.modify(activeRunsRef, (runs) => {
      const active = runs.get(terminalKey(threadId, terminalId)) ?? [];
      const next = replaceRuns(runs, terminalKey(threadId, terminalId), () =>
        active
          .filter((run) => !run.startedActivityRecorded)
          .map((run) => (endsOpening ? { ...run, pendingOutcome: outcome } : run)),
      );
      return [active.filter((run) => run.startedActivityRecorded), next] as const;
    });
    yield* Effect.forEach(ended, (run) => recordOutcome(run, outcome), { discard: true });
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
      // A changed command or cwd replaces the process silently, reporting only the new start.
      case "started":
      case "restarted":
        return finishRun(
          event.threadId,
          event.terminalId,
          { outcome: "failed", reason: "terminal-restarted", exitCode: null, exitSignal: null },
          false,
        );
      default:
        return Effect.void;
    }
  });
  yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

  const recoverInterruptedRuns = Effect.fn("ProjectSetupScriptRunner.recoverInterruptedRuns")(
    function* () {
      const rows = yield* sql<{ readonly thread_id: string; readonly payload_json: string }>`
        SELECT thread_id, payload_json FROM orchestration_v2_projection_turn_items
        WHERE type = 'command_execution' AND status IN ('pending', 'running')
          AND json_type(payload_json, '$.setupScript') = 'object'
      `;
      const items = yield* Effect.forEach(rows, (row) =>
        decodeTurnItemJson(row.payload_json).pipe(Effect.map((item) => ({ row, item }))),
      );
      const activities = items.flatMap(({ row, item }) =>
        item.type !== "command_execution" || item.setupScript === undefined
          ? []
          : [
              {
                threadId: row.thread_id,
                kind: "setup-script.started",
                payload: { ...item.setupScript, command: item.input },
                createdAt: DateTime.formatIso(item.startedAt ?? item.updatedAt),
              },
            ],
      );
      yield* Effect.forEach(
        deriveUnfinishedSetupRuns(activities).filter((run) => !ownRunIds.has(run.runId)),
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
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const fileActionApprovals = yield* ProjectFileActionApprovals.ProjectFileActionApprovals;

  /**
   * Watches the setup terminal until its command process exits. Terminal
   * output is a byte stream, so partial lines are buffered until a newline.
   * The subscription is torn down once an exit, close, error or restart
   * arrives.
   */
  const observeTerminalCompletion = Effect.fn("ProjectSetupScriptRunner.observeTerminalCompletion")(
    function* (input: {
      readonly threadId: string;
      readonly terminalId: string;
      readonly onOutputLine: ((line: string) => Effect.Effect<void>) | undefined;
    }) {
      const startedAtMs = yield* Clock.currentTimeMillis;
      const done = yield* Deferred.make<ProjectSetupScriptCompletion>();
      let lineBuffer = "";
      let settled = false;
      let opening = true;

      let unsubscribe = () => {};
      const settle = (exitCode: number | null, exitSignal: number | null) =>
        Effect.suspend(() => {
          if (settled) return Effect.void;
          settled = true;
          return Clock.currentTimeMillis.pipe(
            Effect.flatMap((nowMs) =>
              Deferred.succeed(done, { exitCode, exitSignal, durationMs: nowMs - startedAtMs }),
            ),
            Effect.asVoid,
            Effect.ensuring(Effect.sync(() => unsubscribe())),
          );
        });

      const handleLine = (rawLine: string) =>
        Effect.suspend(() => {
          const cleaned = stripTerminalControl(rawLine).trimEnd();
          if (cleaned.length === 0 || input.onOutputLine === undefined) {
            return Effect.void;
          }
          return input.onOutputLine(cleaned.slice(0, OUTPUT_LINE_MAX_LENGTH));
        });

      unsubscribe = yield* terminalManager.subscribe((event) => {
        if (event.threadId !== input.threadId || event.terminalId !== input.terminalId) {
          return Effect.void;
        }
        switch (event.type) {
          case "output": {
            lineBuffer += event.data;
            // Bare CR redraws progress in place; split redraws instead of growing one line.
            const lines = lineBuffer.split(/\r\n|\r|\n/);
            lineBuffer = lines.pop() ?? "";
            // A script that never prints a newline must not grow this forever.
            if (lineBuffer.length > PARTIAL_LINE_MAX_LENGTH) {
              lineBuffer = lineBuffer.slice(-PARTIAL_LINE_MAX_LENGTH);
            }
            return Effect.forEach(lines, handleLine, { discard: true });
          }
          case "exited":
            return settle(event.exitCode, event.exitSignal);
          // Another open's new process replaced this one, which reports only the new start.
          case "started":
          case "restarted":
            return opening ? Effect.void : settle(null, null);
          case "closed":
          case "error":
            return settle(null, null);
          default:
            return Effect.void;
        }
      });

      const completion = Deferred.await(done).pipe(
        Effect.ensuring(Effect.sync(() => unsubscribe())),
      );
      return {
        completion,
        unsubscribe,
        opened: () => {
          opening = false;
        },
      };
    },
  );

  // Reserving the range here, as the worktree is created, lets the thread say
  // once that it has no ports instead of each terminal or turn failing.
  const noteMissingWorkspacePorts = Effect.fn("ProjectSetupScriptRunner.noteMissingWorkspacePorts")(
    function* (input: { readonly threadId: string; readonly worktreePath: string }) {
      if ((yield* portAllocator.getBasePort(input.worktreePath)) !== null) return;
      const threadId = ThreadId.make(input.threadId);
      const id = TurnItemId.make(`workspace-ports-unavailable:${input.threadId}`);
      if ((yield* threads.getTurnItem({ threadId, itemId: id })) !== null) return;
      const at = yield* DateTime.now;
      yield* eventSink.write({
        events: [
          {
            id: EventId.make(`workspace-ports-unavailable:${input.threadId}`),
            type: "turn-item.updated",
            threadId,
            occurredAt: at,
            payload: {
              id,
              threadId,
              runId: null,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: yield* positions.allocate({ threadId, turnItemId: id, runId: null }),
              type: "system_notice",
              status: "completed",
              title: "No reserved development ports",
              message: `No free development ports, so this workspace has no reserved ports and ${WorkspacePortAllocator.WORKSPACE_PORT_ENV_VAR} is not set. Ports free up as threads in other worktrees are settled or archived; terminals and agent turns started here after that get them.`,
              startedAt: at,
              completedAt: at,
              updatedAt: at,
            },
          },
        ],
      });
    },
    Effect.ignoreCause({ log: true }),
  );

  const runForThread: ProjectSetupScriptRunner["Service"]["runForThread"] = Effect.fn(
    "ProjectSetupScriptRunner.runForThread",
  )(function* (input) {
    const errorContext = {
      threadId: input.threadId,
      worktreePath: input.worktreePath,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.projectCwd === undefined ? {} : { projectCwd: input.projectCwd }),
    };
    // A thread whose origin cannot be read might be a link's: run nothing.
    const thread = yield* threads.getThreadShell(ThreadId.make(input.threadId)).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectSetupScriptOperationError({
            ...errorContext,
            operation: "readThread",
            cause,
          }),
      ),
    );
    if (thread?.linkOrigin !== undefined && linkOriginIsFenced(thread.linkOrigin))
      return { status: "skipped-for-link" } as const;
    const projectById =
      input.project ??
      (input.projectId
        ? yield* projects.getById(ProjectId.make(input.projectId)).pipe(
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
    const project =
      projectById ??
      (input.projectCwd
        ? yield* projects.getByWorkspaceRoot(input.projectCwd).pipe(
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

    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new ProjectSetupScriptOperationError({
            ...errorContext,
            operation: "readSettings",
            cause,
          }),
      ),
    );
    const trigger = input.trigger ?? "setup";
    if (trigger === "setup") yield* noteMissingWorkspacePorts(input);
    const scripts = resolveProjectActions(
      settings,
      project,
      yield* fileActionApprovals.automationConfig(project),
    );
    const eligible =
      input.expectedActionId === undefined
        ? scripts
        : scripts.filter((script) => script.id === input.expectedActionId);
    const script =
      trigger === "settle" ? settleProjectScript(eligible) : setupProjectScript(eligible);
    if (!script && input.expectedActionId !== undefined) return { status: "no-script" } as const;
    if (!script) {
      // A styal.json action asking for this role runs only once its command is
      // approved; until then the thread says so instead of silently skipping.
      const awaiting = scripts.find((candidate) =>
        candidate.awaitingApproval?.includes(trigger === "settle" ? "settle" : "setup"),
      );
      if (
        awaiting !== undefined &&
        !isProjectCheckoutRun({
          projectCwd: project.workspaceRoot,
          worktreePath: input.worktreePath,
        })
      ) {
        const requestedAt = yield* nowIso;
        nextRunSequence += 1;
        const runId = `${input.threadId}:${awaiting.id}:${requestedAt}:${nextRunSequence}`;
        yield* appendActivity({
          threadId: input.threadId,
          runId,
          kind: "setup-script.awaiting-approval",
          summary: `${awaiting.name} needs approval`,
          tone: "info",
          createdAt: requestedAt,
          payload: {
            runId,
            scriptId: awaiting.id,
            scriptName: awaiting.name,
            scriptIcon: awaiting.icon,
            command: awaiting.command,
            terminalId: `${trigger}-${awaiting.id}`,
            worktreePath: input.worktreePath,
            awaitingApproval: { projectId: project.id, actionId: awaiting.id },
          },
        }).pipe(Effect.ignoreCause({ log: true }));
        return {
          status: "awaiting-approval",
          scriptId: awaiting.id,
          scriptName: awaiting.name,
        } as const;
      }
      return {
        status: "no-script",
      } as const;
    }

    // Each thread has one terminal per lifecycle script. A later run restarts
    // the exited session in place, so settling repeatedly does not pile up tabs.
    const terminalId = `${trigger}-${script.id}`;
    const cwd = input.worktreePath;

    if (trigger === "settle") {
      // A settle script deletes worktree state, so a thread in the project's own
      // checkout skips it like a thread without a worktree, without a work-log row.
      if (isProjectCheckoutRun({ projectCwd: project.workspaceRoot, worktreePath: cwd })) {
        yield* Effect.logInfo("skipped settle script in the project checkout", {
          threadId: input.threadId,
          scriptId: script.id,
          worktreePath: cwd,
        });
        return { status: "not-a-worktree", scriptId: script.id, scriptName: script.name } as const;
      }
      // Reopening a running session would attach to it and start nothing, so a
      // thread that settles again during cleanup leaves the first run going.
      const active = (yield* SynchronizedRef.get(activeRunsRef)).has(
        terminalKey(input.threadId, terminalId),
      );
      if (active) {
        return {
          status: "already-running",
          scriptId: script.id,
          scriptName: script.name,
          terminalId,
        } as const;
      }
    }
    const requestedAt = yield* nowIso;
    nextRunSequence += 1;
    const runId =
      input.resumeRunId ?? `${input.threadId}:${script.id}:${requestedAt}:${nextRunSequence}`;

    // The script was written for a fresh worktree, so running it over the project
    // root is destructive rather than merely useless: a setup line that links
    // $T3CODE_PROJECT_ROOT/.env into the cwd would clobber the file it links to.
    if (
      trigger === "setup" &&
      isLifecycleScriptOutsideWorktree({
        script,
        projectCwd: project.workspaceRoot,
        worktreePath: input.worktreePath,
      })
    ) {
      yield* Effect.logWarning("refused to run setup script outside a worktree", {
        threadId: input.threadId,
        scriptId: script.id,
        projectCwd: project.workspaceRoot,
        worktreePath: input.worktreePath,
      });
      yield* appendActivity({
        threadId: input.threadId,
        runId,
        kind: "setup-script.failed",
        summary: "Setup script did not run",
        tone: "error",
        createdAt: requestedAt,
        payload: {
          runId,
          scriptId: script.id,
          scriptName: script.name,
          ...(script.icon ? { scriptIcon: script.icon } : {}),
          command: script.command,
          worktreePath: input.worktreePath,
          outcome: "failed",
          failureReason: "launch-error",
          detail:
            "This action runs after a worktree is created. In a local thread it would run in the project root and could overwrite the files it sets up.",
        },
      }).pipe(Effect.ignoreCause({ log: true }));
      return {
        status: "not-a-worktree",
        scriptId: script.id,
        scriptName: script.name,
      } as const;
    }

    const env = projectScriptRuntimeEnv({
      project: { cwd: project.workspaceRoot },
      worktreePath: input.worktreePath,
    });

    const activeRun: ActiveSetupRun = {
      runId,
      threadId: input.threadId,
      trigger,
      scriptId: script.id,
      scriptName: script.name,
      scriptIcon: script.icon,
      command: script.command,
      terminalId,
      worktreePath: input.worktreePath,
      startedAt: requestedAt,
      startedActivityRecorded: false,
      pendingOutcome: null,
      clearsSetupRecord: input.clearsSetupRecord === true,
    };
    ownRunIds.add(runId);
    const runKey = terminalKey(input.threadId, terminalId);
    const withoutThisRun = (runs: ReadonlyMap<string, ReadonlyArray<ActiveSetupRun>>) =>
      replaceRuns(runs, runKey, (active) => active.filter((run) => run.runId !== runId));
    yield* SynchronizedRef.update(activeRunsRef, (runs) =>
      replaceRuns(runs, runKey, (active) => [...active, activeRun]),
    );
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
        scriptIcon: script.icon,
        command: script.command,
        terminalId,
        worktreePath: input.worktreePath,
      },
    }).pipe(Effect.ignoreCause({ log: true }));

    // Subscribe before opening so an exit during the open cannot be missed.
    const observed = input.observeCompletion
      ? yield* observeTerminalCompletion({
          threadId: input.threadId,
          terminalId,
          onOutputLine: input.observeCompletion.onOutputLine,
        })
      : undefined;

    const terminal = yield* terminalManager
      .openCommand(
        {
          threadId: input.threadId,
          terminalId,
          stopOnSettle: script.stopOnSettle ?? false,
          cwd,
          worktreePath: input.worktreePath,
          env: { ...env, NO_COLOR: "1", FORCE_COLOR: "0" },
          command: script.command,
          label: script.name,
        },
        { workspaceLeaseHeld: input.workspaceLeaseHeld === true },
      )
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
          SynchronizedRef.update(activeRunsRef, withoutThisRun).pipe(
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
        Effect.tapError(() => Effect.sync(() => observed?.unsubscribe())),
      );

    observed?.opened();
    if (terminal.status === "error") {
      observed?.unsubscribe();
      const startError = new ProjectSetupScriptOperationError({
        ...errorContext,
        operation: "openTerminal",
        cause: new Error(`Setup terminal '${terminalId}' failed to start.`),
      });
      yield* SynchronizedRef.update(activeRunsRef, withoutThisRun);
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
        scriptIcon: script.icon,
        command: script.command,
        terminalId,
        worktreePath: input.worktreePath,
      },
    }).pipe(Effect.ignoreCause({ log: true }));

    const pendingOutcome = yield* SynchronizedRef.modify(activeRunsRef, (runs) => {
      const run = runs.get(runKey)?.find((candidate) => candidate.runId === runId);
      if (!run) return [Option.none<readonly [ActiveSetupRun, SetupRunOutcome]>(), runs] as const;
      if (run.pendingOutcome) {
        return [Option.some([run, run.pendingOutcome] as const), withoutThisRun(runs)] as const;
      }
      const next = replaceRuns(runs, runKey, (active) =>
        active.map((candidate) =>
          candidate.runId === runId ? { ...candidate, startedActivityRecorded: true } : candidate,
        ),
      );
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
      scriptCommand: script.command,
      terminalId,
      cwd,
      async: script.async !== false,
      ...(observed ? { completion: observed.completion } : {}),
    } as const;
  });

  const withWorkspaceLease = yield* makeWorkspaceLease;
  const checkoutRoot = yield* makeCheckoutRoot;

  const runPending = Effect.fn("ProjectSetupScriptRunner.runPending")(
    function* (input: { readonly threadId: ThreadId; readonly turnItemId: TurnItemId }) {
      const rows = yield* sql<{ readonly payload_json: string }>`
      SELECT payload_json FROM orchestration_v2_projection_turn_items
      WHERE thread_id = ${input.threadId} AND turn_item_id = ${input.turnItemId}
    `;
      const item =
        rows[0] === undefined ? undefined : yield* decodeTurnItemJson(rows[0].payload_json);
      if (
        item?.type !== "command_execution" ||
        item.status !== "idle" ||
        !item.setupScript?.awaitingApproval
      ) {
        return yield* new ProjectFileActionApprovalError({
          reason: "run-failed",
          message: "This action is no longer waiting for approval.",
        });
      }
      const shell = yield* threads.getThreadShell(input.threadId);
      if (shell?.projectId !== item.setupScript.awaitingApproval.projectId) {
        return yield* new ProjectFileActionApprovalError({
          reason: "run-failed",
          message: "This action does not belong to the thread's project.",
        });
      }
      const run = {
        threadId: input.threadId,
        projectId: shell.projectId,
        worktreePath: item.setupScript.worktreePath,
        trigger: triggerForTerminalId(item.setupScript.terminalId),
        expectedActionId: item.setupScript.awaitingApproval.actionId,
        resumeRunId: item.setupScript.runId,
      };
      // Leases the root turns and terminals lease, but starts its own run rather than joining the
      // root's shared one, so overlapping setup can run twice; its end clears a pending record.
      const started = yield* withWorkspaceLease(
        yield* checkoutRoot(run.worktreePath, { worktree: true }),
        Effect.gen(function* () {
          const result = yield* runForThread({
            ...run,
            workspaceLeaseHeld: true,
            clearsSetupRecord: run.trigger === "setup" && (yield* isStripped(run.worktreePath)),
          });
          return result.status === "started";
        }),
      );
      if (!started) {
        return yield* new ProjectFileActionApprovalError({
          reason: "run-failed",
          message: "The action could not run. Review its current command and approval.",
        });
      }
    },
    Effect.mapError(
      (cause) =>
        new ProjectFileActionApprovalError({
          reason: "run-failed",
          message: cause instanceof Error ? cause.message : "Could not run the approved action.",
        }),
    ),
  );

  return ProjectSetupScriptRunner.of({
    runForThread,
    runPending,
    isStripped,
    consumeStripped,
    // This scope closes before TerminalManager's, so a shutdown does not count as setup ending.
    setUpStripped: yield* makeSetUpStripped({ runForThread, isStripped, consumeStripped }),
    markStripped: Effect.fn("ProjectSetupScriptRunner.markStripped")(function* (root, projectId) {
      const strippedAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`INSERT INTO worktree_stripped (worktree_path, project_id, stripped_at) VALUES (${root}, ${projectId}, ${strippedAt}) ON CONFLICT (worktree_path) DO NOTHING`;
    }, Effect.orDie),
  });
});

export const layer = Layer.effect(ProjectSetupScriptRunner, make);
