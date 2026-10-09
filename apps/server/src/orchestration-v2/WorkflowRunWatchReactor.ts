import {
  CommandId,
  MessageId,
  type OrchestrationV2Notification,
  type ThreadWorkflowRunWatch,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import { PullRequestProviderError } from "@t3tools/source-control-core/server/PullRequestProvider";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import { forkParked } from "../serverActivation.ts";
import * as AnalyticsService from "../telemetry/AnalyticsService.ts";
import * as WorkflowRunWatchUsage from "../telemetry/WorkflowRunWatchUsage.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { workflowRunCompletedMessage, workflowRunUnreadableMessage } from "./workflowRunWatch.ts";

/** Minutes between passes. Runs take minutes, and each pass spends one REST read per run. */
const SWEEP_MINUTES = 2;
/** Reads in a row that failed for a reason other than a rate limit before the watch ends. */
const READ_FAILURE_LIMIT = 8;

const isProviderError = Schema.is(PullRequestProviderError);

/** A rate limit is the host asking us to wait, not a sign the run cannot be read. */
const isRateLimited = (cause: Cause.Cause<PullRequestService.PullRequestError>) =>
  Option.match(Cause.findErrorOption(cause), {
    onNone: () => false,
    onSome: (error) =>
      error._tag === "PullRequestOperationError" &&
      isProviderError(error.cause) &&
      error.cause.reason === "rate-limited",
  });

interface WatchTarget {
  readonly thread: ProjectionStore.ProjectionThreadWorkflowRuns;
  readonly watch: ThreadWorkflowRunWatch;
}

const targetKey = ({ thread, watch }: WatchTarget) =>
  `${thread.id} ${watch.host}/${watch.repository}/${watch.runId} ${watch.startedAt}`;

/**
 * Wakes a thread's agent once when a CI workflow run it watches (`watch_workflow_run`)
 * completes, and ends the watch in the same step. A pass every two minutes reads each watched
 * run. Settling, archiving, or stopping a thread ends its watches in the orchestrator.
 */
export class WorkflowRunWatchReactor extends Context.Service<
  WorkflowRunWatchReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** One pass over every watched workflow run. */
    readonly sweep: Effect.Effect<void>;
  }
>()("@styal/cli/orchestration-v2/WorkflowRunWatchReactor") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const crypto = yield* Crypto.Crypto;
  const analytics = yield* AnalyticsService.AnalyticsService;
  // Reads in a row that failed, per watch. Kept in memory: a restart only delays the stop.
  const readFailures = new Map<string, number>();
  // Watches seen by a pass, to record how each one ended. Kept in memory: a watch that starts
  // and ends between two passes, or ends while the server is down, is not recorded.
  const seen = new Map<string, number>();

  const recordEnd = (key: string, end: WorkflowRunWatchUsage.WorkflowRunWatchEnd) =>
    Effect.gen(function* () {
      const startedAt = seen.get(key);
      seen.delete(key);
      if (startedAt === undefined) return;
      const now = yield* Clock.currentTimeMillis;
      yield* WorkflowRunWatchUsage.recordEnd(end, now - startedAt).pipe(
        Effect.provideService(AnalyticsService.AnalyticsService, analytics),
      );
    });

  /** Ends the watch, waking the agent when `wake` is set. Refused if the watch already ended. */
  const finish = (
    target: WatchTarget,
    wake?: { readonly text: string; readonly notification: OrchestrationV2Notification },
  ) =>
    Effect.gen(function* () {
      const uuid = yield* crypto.randomUUIDv4;
      yield* engine.dispatch({
        type: "thread.workflow-run-watch.finish",
        commandId: CommandId.make(`server:workflow-run-watch:${target.thread.id}:${uuid}`),
        threadId: target.thread.id,
        host: target.watch.host,
        repository: target.watch.repository,
        runId: target.watch.runId,
        startedAt: target.watch.startedAt,
        ...(wake === undefined
          ? {}
          : { wake: { ...wake, messageId: MessageId.make(`message:workflow-run-watch:${uuid}`) } }),
      });
    });

  const check = Effect.fn("WorkflowRunWatchReactor.check")(function* (target: WatchTarget) {
    const key = targetKey(target);
    // Settling ends watches; one left from a race ends here without a wake.
    if (target.thread.settledOverride === "settled" || target.thread.settledAt !== null) {
      readFailures.delete(key);
      return yield* finish(target);
    }
    const read = yield* Effect.exit(
      pullRequests.workflowRun({
        projectId: target.thread.projectId,
        host: target.watch.host,
        repository: target.watch.repository,
        runId: target.watch.runId,
      }),
    );
    if (Exit.isFailure(read)) {
      if (Cause.hasInterruptsOnly(read.cause)) return yield* Effect.failCause(read.cause);
      if (isRateLimited(read.cause)) return;
      const failures = (readFailures.get(key) ?? 0) + 1;
      readFailures.set(key, failures);
      if (failures >= READ_FAILURE_LIMIT) {
        // The count stays until the stop lands, so a failed stop is tried again next pass.
        yield* finish(target, workflowRunUnreadableMessage(target.watch, failures)).pipe(
          Effect.catch(() => finish(target)),
        );
        readFailures.delete(key);
        yield* recordEnd(key, { reason: "unreadable" });
      }
      return yield* Effect.failCause(read.cause);
    }
    readFailures.delete(key);
    if (!read.value.completed) return;
    yield* finish(target, workflowRunCompletedMessage(target.watch, read.value));
    yield* recordEnd(key, { reason: "completed", conclusion: read.value.conclusion });
  });

  const sweep = Effect.gen(function* () {
    const threads = yield* projections.getThreadsWithWorkflowRuns();
    const targets = threads.flatMap((thread) =>
      thread.workflowRuns.map((watch): WatchTarget => ({ thread, watch })),
    );
    const present = new Set(targets.map(targetKey));
    for (const key of readFailures.keys()) if (!present.has(key)) readFailures.delete(key);
    // A watch seen last pass and gone now was ended outside this reactor.
    for (const key of seen.keys()) {
      if (!present.has(key)) yield* recordEnd(key, { reason: "stopped" });
    }
    for (const target of targets) {
      const key = targetKey(target);
      if (!seen.has(key)) seen.set(key, Date.parse(target.watch.startedAt));
    }
    yield* Effect.forEach(
      targets,
      (target) =>
        check(target).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logWarning("workflow run watch check failed", {
                  threadId: target.thread.id,
                  run: `${target.watch.repository}/${target.watch.runId}`,
                  cause,
                }),
          ),
        ),
      { concurrency: 4, discard: true },
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("workflow run watch sweep failed", { cause }),
    ),
    Effect.withSpan("WorkflowRunWatchReactor.sweep"),
  );

  const start: WorkflowRunWatchReactor["Service"]["start"] = () =>
    forkParked(
      sweep.pipe(Effect.repeat(Schedule.spaced(`${SWEEP_MINUTES} minutes`)), Effect.asVoid),
    );

  return { start, sweep } satisfies WorkflowRunWatchReactor["Service"];
});

export const layer = Layer.effect(WorkflowRunWatchReactor, make);
