import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  CommandId,
  IDLE_COMPACTION_TEXT,
  idleCompactionOf,
  isCompactionCommandMessage,
  isOrchestrationV2WorkActive,
  MessageId,
  type OrchestrationV2Run,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type {
  ProjectionRecordFilter,
  ProjectionRecords,
  ProjectionRuntimeRecoveryState,
} from "./ProjectionStore.ts";

import * as ServerSettings from "../serverSettings.ts";
import { isNativeMaintenanceCommand } from "./CommandPolicy.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import {
  awaitingProviderThreadId,
  cancelledRosterTaskWork,
  cancelledTurnItemWork,
  continuationFailedBeforePrompt,
  isAwaitedWork,
  isRestartContinuationSource,
  cancelledBeforeStart,
  isRestartNoteSource,
  neverStarted,
  restartCancelledBackgroundWorkNote,
  restartContinuationNote,
  restartContinuationBlocked,
} from "./RestartBackgroundNote.ts";

export const CONTINUE_PROMPT =
  "Continue where you left off. Your last turn was cut short, so a command or other action it started may have finished or may still be running. Before you repeat one that changes state, confirm it did not take effect and is not still running; if you cannot tell, say so instead of repeating it.";
// Without this the agent sees only a killed tool result (often exit 137) and
// may blame the command itself, e.g. as an out-of-memory kill.
export const INTERRUPTED_TURN_NOTE =
  "Note: the styal server restarted and interrupted this turn. Check unfinished work before retrying.";

const MAX_CONTINUATION_CHAIN = 3;
const CONTINUATION_LOOP_WINDOW_MS = 5 * 60 * 1_000;

/** App-owned delegations continue in their own threads and report back. */
function hasOpenAwaitedWork(
  projection: Pick<ProjectionRuntimeRecoveryState, "runs" | "turnItems">,
  providerThread: ProjectionRuntimeRecoveryState["providerThreads"][number],
): boolean {
  const openItem = projection.turnItems.some((item) => {
    if (item.status !== "pending" && item.status !== "running" && item.status !== "waiting")
      return false;
    if (item.type === "subagent" && item.origin === "app_owned" && item.childThreadId !== null)
      return false;
    const work = cancelledTurnItemWork(item);
    return (
      work !== undefined &&
      isAwaitedWork(work) &&
      awaitingProviderThreadId(item, projection.runs) === providerThread.id
    );
  });
  return (
    openItem ||
    (providerThread.ownerNodeId === null &&
      (providerThread.pendingBackgroundTasks ?? []).some((task) =>
        isAwaitedWork(cancelledRosterTaskWork(task)),
      ))
  );
}

/** Settled runs require a live session so stale crash records cannot wake them. */
export function restartContinuationRun(
  projection: Pick<
    ProjectionRuntimeRecoveryState,
    | "thread"
    | "runs"
    | "providerThreads"
    | "providerSessions"
    | "providerTurns"
    | "runtimeRequests"
    | "turnItems"
  >,
  now: DateTime.Utc,
): OrchestrationV2Run | undefined {
  const run = projection.runs.reduce<OrchestrationV2Run | undefined>(
    (latest, candidate) =>
      candidate.status !== "queued" &&
      !neverStarted(candidate) &&
      (!latest || runRanAfter(candidate, latest))
        ? candidate
        : latest,
    undefined,
  );
  if (!run) return;
  const preparedContinuation =
    run.status === "starting" && run.restartContinuationOfRunId !== undefined;
  const settled = run.status === "completed" || run.status === "waiting";
  if (run.status !== "running" && !preparedContinuation && !settled) return;
  if (restartContinuationBlocked(projection, run, now, settled)) return;
  const liveTurnRequired = !preparedContinuation && !settled;
  if (projection.thread.providerInstanceId !== run.providerInstanceId) return;
  const providerThread = projection.providerThreads.find(
    (thread) => thread.id === run.providerThreadId,
  );
  if (
    !providerThread ||
    providerThread.appThreadId !== projection.thread.id ||
    providerThread.ownerNodeId !== null ||
    providerThread.providerInstanceId !== run.providerInstanceId ||
    providerThread.nativeThreadRef?.nativeId == null ||
    providerThread.nativeThreadRef.strength !== "strong" ||
    providerThread.nativeThreadRef.driver !== providerThread.driver ||
    (liveTurnRequired && providerThread.status !== "active") ||
    providerThread.status === "closed" ||
    providerThread.status === "archived"
  )
    return;
  const session = projection.providerSessions.find(
    (candidate) => candidate.id === providerThread.providerSessionId,
  );
  // Adapters remain ready during turns; only stopped or failed sessions rule out live work.
  // Shutdown prepares the continuation before stopping providers and a crash leaves sessions
  // unstopped, so an already stopped session leaves only stale background records.
  if (
    session === undefined ||
    session.providerInstanceId !== run.providerInstanceId ||
    session.driver !== providerThread.driver ||
    (!preparedContinuation && (session.status === "stopped" || session.status === "error"))
  )
    return;
  if (settled) return hasOpenAwaitedWork(projection, providerThread) ? run : undefined;
  if (
    liveTurnRequired &&
    !projection.providerTurns.some(
      (turn) =>
        turn.providerThreadId === providerThread.id &&
        turn.runAttemptId === run.activeAttemptId &&
        turn.status === "running",
    )
  )
    return;
  return run;
}

/**
 * True when `run` ends a chain of automatic continuations that reached the
 * limit within five minutes. A turn that keeps crashing the server would
 * otherwise restart it forever. A restart preview passes `now` for a run that
 * is still working, because recovery completes it at the restart.
 */
export function restartContinuationChainFull(
  run: OrchestrationV2Run,
  runs: ReadonlyArray<OrchestrationV2Run>,
  now?: DateTime.Utc,
): boolean {
  let chainLength = 0;
  const loopWindowStart =
    DateTime.toEpochMillis(run.completedAt ?? now ?? run.requestedAt) - CONTINUATION_LOOP_WINDOW_MS;
  for (
    let current: OrchestrationV2Run | undefined = run;
    current?.restartContinuationOfRunId !== undefined && chainLength < MAX_CONTINUATION_CHAIN;
    current = runs.find((candidate) => candidate.id === current?.restartContinuationOfRunId)
  ) {
    if (DateTime.toEpochMillis(current.requestedAt) < loopWindowStart) break;
    chainLength += 1;
  }
  return chainLength >= MAX_CONTINUATION_CHAIN;
}

/** The records `declinesRestartContinuation` reads for `run`. */
export function restartContinuationDeclineFilter(
  run: Pick<OrchestrationV2Run, "id" | "userMessageId">,
): ProjectionRecordFilter {
  return {
    messageIds: [run.userMessageId],
    turnItemRunIds: [run.id],
    turnItemTypes: ["run_interrupt_request"],
  };
}

/**
 * True when restart continuation never resumes `run`: the user asked it to stop
 * before the restart cut it, or it ran `/logout`. Read `records` with `restartContinuationDeclineFilter(run)`.
 */
export function declinesRestartContinuation(
  run: Pick<OrchestrationV2Run, "id" | "userMessageId">,
  records: Pick<ProjectionRecords<"messages" | "turnItems">, "messages" | "turnItems">,
): boolean {
  if (
    records.turnItems.some((item) => item.runId === run.id && item.type === "run_interrupt_request")
  )
    return true;
  const message = records.messages.find((candidate) => candidate.id === run.userMessageId);
  return (
    message !== undefined &&
    isNativeMaintenanceCommand(message) &&
    !isCompactionCommandMessage(message)
  );
}

export const continueRestartedRun = Effect.fn("RestartContinuation.continueRestartedRun")(
  function* (input: {
    readonly threadId: ThreadId;
    readonly sourceRunId: RunId;
    readonly processLossCount?: number;
  }) {
    const settings = yield* ServerSettings.ServerSettingsService;
    const enabled = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
    if (!enabled) return;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const messageId = MessageId.make(`message:restart-continuation:${input.sourceRunId}`);
    const projection = yield* threads.getThreadRecords(
      input.threadId,
      ["messages", "runs", "providerTurns", "attempts", "runtimeRequests", "turnItems"],
      { messageIds: [messageId], turnItemTypes: ["secret_request"] },
    );
    const source = projection.runs.find((run) => run.id === input.sourceRunId);
    if (source === undefined) return;
    const sourceRecords = yield* threads.getThreadRecords(
      input.threadId,
      ["messages", "turnItems"],
      restartContinuationDeclineFilter(source),
    );
    const sourceMessage = sourceRecords.messages.find(
      (message) => message.id === source.userMessageId,
    );
    const automaticCompaction =
      sourceMessage !== undefined &&
      idleCompactionOf(sourceMessage) === "beforeCacheExpires" &&
      !isRestartNoteSource(source, projection.providerTurns);
    if (
      !automaticCompaction &&
      !resolveProjectSettings(enabled, projection.thread.projectId).settings
        .continueThreadsAfterServerUpdate
    )
      return;
    if (projection.messages.some((message) => message.id === messageId)) return;
    if (
      !(
        isRestartContinuationSource(source, projection.providerTurns) ||
        continuationFailedBeforePrompt(source, projection.providerTurns)
      ) ||
      (!automaticCompaction &&
        restartContinuationBlocked(
          projection,
          source,
          yield* DateTime.now,
          isRestartNoteSource(source, projection.providerTurns),
        ))
    )
      return;
    if (
      !automaticCompaction &&
      projection.runs.some(
        (run) =>
          run.id !== source.id &&
          run.status !== "queued" &&
          !cancelledBeforeStart(run) &&
          runRanAfter(run, source),
      )
    )
      return;
    if (!automaticCompaction && projection.thread.providerInstanceId !== source.providerInstanceId)
      return;
    if (
      !automaticCompaction &&
      (input.processLossCount === undefined
        ? restartContinuationChainFull(source, projection.runs)
        : input.processLossCount > MAX_CONTINUATION_CHAIN)
    ) {
      yield* Effect.logWarning("Not continuing a run restarted too many times in a row", {
        threadId: input.threadId,
        sourceRunId: input.sourceRunId,
      });
      return;
    }
    if (declinesRestartContinuation(source, sourceRecords)) return;
    // A parent's Stop reaches its open delegated tasks through an effect a restart can cut short.
    const { lineage, forkedFrom } = projection.thread;
    const taskId =
      source.delegatedTaskId ?? (forkedFrom?.type === "node" ? forkedFrom.nodeId : undefined);
    if (
      lineage.relationshipToParent === "subagent" &&
      lineage.parentThreadId !== null &&
      taskId !== undefined
    ) {
      const task = (yield* threads.getThreadRecords(lineage.parentThreadId, ["subagents"], {
        subagentIds: [taskId],
      })).subagents.find((candidate) => candidate.id === taskId);
      // A settled task no longer owns later work in its thread.
      const parentRunId =
        task !== undefined && task.result === null && isOrchestrationV2WorkActive(task.status)
          ? task.runId
          : null;
      if (
        parentRunId !== null &&
        (yield* threads.getThreadRecords(lineage.parentThreadId, ["turnItems"], {
          turnItemTypes: ["run_interrupt_request"],
          turnItemRunIds: [parentRunId],
        })).turnItems.length > 0
      )
        return;
    }
    // Compaction changes nothing a repeat could double, so a cut one runs again.
    const recompact =
      sourceMessage !== undefined &&
      isCompactionCommandMessage(sourceMessage) &&
      !isRestartNoteSource(source, projection.providerTurns);
    const note = restartContinuationNote(
      source,
      projection.runs,
      projection.providerTurns,
      projection.attempts,
    );
    const noteText =
      note.work.length === 0 ? undefined : restartCancelledBackgroundWorkNote(note.work);
    const text =
      note.settled && noteText !== undefined
        ? noteText
        : [noteText, INTERRUPTED_TURN_NOTE, CONTINUE_PROMPT]
            .filter((part) => part !== undefined)
            .join("\n\n");
    yield* threads
      .dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`command:restart-continuation:${input.sourceRunId}`),
        threadId: input.threadId,
        messageId,
        text: recompact ? IDLE_COMPACTION_TEXT : text,
        idleCompaction: recompact ? idleCompactionOf(sourceMessage) : undefined,
        notification: recompact
          ? undefined
          : {
              source: { kind: "system" },
              outcome: "updated",
              summary: note.settled
                ? "styal restarted and stopped background work"
                : "styal restarted and resumed this turn",
              detail: text,
            },
        attachments: [],
        modelSelection: source.modelSelection,
        dispatchMode: { type: "start_immediately" },
        // Agent + server with no idleCompaction reads as an automatic idle compaction.
        createdBy: !recompact
          ? "agent"
          : idleCompactionOf(sourceMessage) === undefined
            ? "user"
            : sourceMessage.createdBy,
        creationSource: "server",
        restartContinuationOfRunId: input.sourceRunId,
      })
      .pipe(
        // Disabled instances, and threads above a policy ceiling, cannot resume; still run success
        // cleanup so delegated children recover without futile retries.
        Effect.catchTags({
          ThreadManagementProviderInstanceDisabledError: (error) =>
            Effect.logInfo("orchestration-v2.restart-continuation.instance-disabled", {
              threadId: input.threadId,
              sourceRunId: input.sourceRunId,
              projectId: error.projectId,
              instanceId: error.instanceId,
            }),
          OrchestratorRuntimeModeAboveCeilingError: () =>
            Effect.logInfo("orchestration-v2.restart-continuation.above-ceiling", {
              threadId: input.threadId,
              sourceRunId: input.sourceRunId,
            }),
        }),
      );
  },
  // Declined child continuations still owe parent results; existing continuation runs settle them instead.
  (effect, input) =>
    effect.pipe(
      Effect.andThen(
        Effect.gen(function* () {
          const threads = yield* ThreadManagementService.ThreadManagementService;
          yield* threads.recoverDelegatedTask(input.threadId, { sourceRunId: input.sourceRunId });
        }),
      ),
    ),
);
