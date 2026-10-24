import { TurnItemId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

import { forkParked } from "../serverActivation.ts";
import * as AnalyticsService from "../telemetry/AnalyticsService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

// Startup may include context preparation and CLI hooks. Silence after attachment
// is less conclusive, so it gets a longer budget and excludes open work items.
const STARTUP_QUIET_MS = 5 * 60_000;
const PROVIDER_QUIET_MS = 10 * 60_000;
const SWEEP_MS = 30_000;

type Notice = Extract<OrchestrationV2TurnItem, { type: "system_notice" }>;

export class ProviderStallMonitor extends Context.Service<
  ProviderStallMonitor,
  {
    readonly sweep: Effect.Effect<void>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@styal/cli/orchestration-v2/ProviderStallMonitor") {}

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const analytics = yield* AnalyticsService.AnalyticsService;
  const providers = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const lock = yield* Semaphore.make(1);

  const record = Effect.fnUntraced(function* (
    item: Notice,
    outcome: "detected" | "activity" | "waiting" | "run_ended",
    providerInstanceId: Parameters<typeof providers.getInstance>[0] | undefined,
    now: number,
  ) {
    const incident = item.providerStall;
    if (incident === undefined) return;
    const provider =
      providerInstanceId === undefined
        ? undefined
        : yield* providers.getInstance(providerInstanceId);
    yield* analytics.record("provider.turn.stall", {
      provider: provider?.driverKind ?? "unknown",
      phase: incident.phase,
      outcome,
      quietDurationMs: incident.detectedAt - incident.lastActivityAt,
      incidentDurationMs: Math.max(0, now - incident.detectedAt),
    });
  });

  const resolve = Effect.fnUntraced(function* (
    item: Notice,
    candidate: ProjectionStore.ProjectionProviderStallCandidate | undefined,
    now: DateTime.Utc,
  ) {
    const incident = item.providerStall;
    if (incident === undefined) return;
    const resolution =
      candidate === undefined ? "run_ended" : candidate.blocked ? "waiting" : "activity";
    const message =
      resolution === "run_ended"
        ? "The turn ended after a period without activity."
        : resolution === "waiting"
          ? "The agent is waiting or has work in progress; the inactivity warning has cleared."
          : "Agent activity resumed; the inactivity warning has cleared.";
    const updated: Notice = {
      ...item,
      message,
      updatedAt: now,
      providerStall: { ...incident, resolvedAt: DateTime.toEpochMillis(now), resolution },
    };
    yield* sink.write({
      events: [
        {
          id: yield* ids.allocate.event({ threadId: item.threadId }),
          type: "turn-item.updated",
          threadId: item.threadId,
          ...(item.runId === null ? {} : { runId: item.runId }),
          occurredAt: now,
          payload: updated,
        },
      ],
    });
    const run =
      candidate?.run ??
      (yield* projections.getThreadRecords(item.threadId, ["runs"], {
        runIds: item.runId === null ? [] : [item.runId],
      })).runs[0];
    yield* record(updated, resolution, run?.providerInstanceId, DateTime.toEpochMillis(now));
  });

  const detect = Effect.fnUntraced(function* (
    candidate: ProjectionStore.ProjectionProviderStallCandidate,
    now: DateTime.Utc,
  ) {
    const nowMs = DateTime.toEpochMillis(now);
    const quietMs = nowMs - candidate.lastActivityAt;
    if (
      candidate.blocked ||
      quietMs < (candidate.phase === "startup" ? STARTUP_QUIET_MS : PROVIDER_QUIET_MS)
    )
      return;
    const { run } = candidate;
    const id = TurnItemId.make(
      `turn-item:provider-stall:${candidate.attemptId}:${candidate.phase}:${candidate.lastActivityAt}`,
    );
    // A resolved episode is still evidence. The same inactivity baseline never
    // creates another notice, including after a monitor/server restart.
    if ((yield* projections.getTurnItem({ threadId: run.threadId, itemId: id })) != null) return;
    const minutes = Math.floor(quietMs / 60_000);
    const item: Notice = {
      id,
      threadId: run.threadId,
      runId: run.id,
      nodeId: run.rootNodeId,
      providerThreadId: run.providerThreadId,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      type: "system_notice",
      status: "completed",
      title: "Agent may be stuck",
      message:
        candidate.phase === "startup"
          ? `The agent may be stuck starting: no progress for ${minutes} minutes. You can stop this turn and continue in the same thread.`
          : `The agent may be stuck: no new activity for ${minutes} minutes. You can stop this turn and continue in the same thread.`,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      providerStall: {
        attemptId: candidate.attemptId,
        phase: candidate.phase,
        detectedAt: nowMs,
        lastActivityAt: candidate.lastActivityAt,
      },
    };
    const committed = yield* sink.writeIfRunCurrent({
      threadId: run.threadId,
      runId: run.id,
      activeAttemptId: candidate.attemptId,
      expectedStatus: run.status,
      providerStallGuard: { lastActivityAt: candidate.lastActivityAt, phase: candidate.phase },
      events: [
        {
          id: yield* ids.allocate.event({ threadId: run.threadId }),
          type: "turn-item.updated",
          threadId: run.threadId,
          runId: run.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: item,
        },
      ],
    });
    if (committed.committed) {
      yield* record(item, "detected", run.providerInstanceId, nowMs);
      yield* Effect.logWarning("orchestration-v2.provider-turn-stall", {
        threadId: run.threadId,
        runId: run.id,
        attemptId: candidate.attemptId,
        phase: candidate.phase,
        quietDurationMs: quietMs,
      });
    }
  });

  const sweep = Effect.gen(function* () {
    const now = yield* DateTime.now;
    const candidates = yield* projections.getProviderStallCandidates();
    const open = yield* projections.getOpenProviderStalls();
    for (const notice of open) {
      const candidate = candidates.find(
        (item) => item.attemptId === notice.providerStall?.attemptId,
      );
      if (
        candidate === undefined ||
        candidate.blocked ||
        candidate.phase !== notice.providerStall?.phase ||
        candidate.lastActivityAt > notice.providerStall!.lastActivityAt
      ) {
        yield* resolve(notice, candidate, now);
      }
    }
    for (const candidate of candidates) yield* detect(candidate, now);
  }).pipe(
    lock.withPermit,
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("Provider stall detection could not complete its sweep.", { cause }),
    ),
  );

  return ProviderStallMonitor.of({
    sweep,
    start: () => forkParked(Effect.forever(sweep.pipe(Effect.andThen(Effect.sleep(SWEEP_MS))))),
  });
});

export const layer = Layer.effect(ProviderStallMonitor, make);
