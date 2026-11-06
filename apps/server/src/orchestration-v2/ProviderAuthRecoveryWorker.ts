import {
  CommandId,
  MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as DueHint from "../scheduling/DueHint.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { forkParked } from "../serverActivation.ts";
import * as AnalyticsService from "../telemetry/AnalyticsService.ts";
import * as ProviderSignInRecoveryUsage from "../telemetry/ProviderSignInRecoveryUsage.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectionStoreService from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

/** Only a credential file's clock or a status change can show a sign-in made outside styal. */
const CHECK_WHILE_WAITING_MS = 10_000;

export interface ProviderSignInSignal {
  readonly status: ServerProvider["auth"]["status"];
  /** An in-app sign-in. It counts against the run's start: that process has stale credentials. */
  readonly signedInAtMs: number | null;
  /** The CLI rewrote its login. Routine token refreshes do too, so it must follow the failure. */
  readonly credentialsChangedAtMs: number | null;
}

/**
 * Decides the next step for a run stopped by a signed-out provider. A resumed run that fails again
 * is a new run with a later start, so only a further sign-in can resume it: no retry loop.
 */
export function authRecoveryCommand(
  thread: ProjectionStore.ProjectionAuthRecoveryCandidate,
  signal: ProviderSignInSignal,
  nowMs: number,
): OrchestrationV2Command | null {
  const { latestRunId: runId, authRecovery: recovery } = thread;
  if (!runId || thread.archivedAt !== null || thread.settledOverride === "settled") return null;
  const identity = `${thread.id}:${runId}`;
  const signedOut = signal.status === "unauthenticated";
  if (recovery?.runId !== runId) {
    return {
      type: "thread.metadata.update",
      commandId: CommandId.make(`auth-arm:${identity}`),
      threadId: thread.id,
      authRecovery: { runId, waiting: true, signedOutSeen: signedOut },
    };
  }
  if (!recovery.waiting) return null;
  if (signedOut && !recovery.signedOutSeen) {
    return {
      type: "thread.metadata.update",
      commandId: CommandId.make(`auth-signed-out:${identity}`),
      threadId: thread.id,
      authRecovery: { runId, signedOutSeen: true },
    };
  }
  const startedAtMs = thread.latestRunStartedAt
    ? DateTime.toEpochMillis(thread.latestRunStartedAt)
    : 0;
  const failedAtMs = thread.latestRunCompletedAt
    ? DateTime.toEpochMillis(thread.latestRunCompletedAt)
    : nowMs;
  const signedIn =
    (signal.signedInAtMs !== null && signal.signedInAtMs > startedAtMs) ||
    (signal.credentialsChangedAtMs !== null && signal.credentialsChangedAtMs > failedAtMs) ||
    (recovery.signedOutSeen && signal.status === "authenticated");
  if (
    !signedIn ||
    (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > nowMs)
  )
    return null;
  const deliveryIdentity = `${identity}:${recovery.requestId ?? "armed"}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`auth-resume:${deliveryIdentity}`),
    messageId: MessageId.make(`auth-resume:${deliveryIdentity}`),
    threadId: thread.id,
    authContinuationOfRunId: runId,
    ...(recovery.requestId === undefined ? {} : { authRecoveryRequestId: recovery.requestId }),
    text: "Continue where you left off.",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "server",
  };
}

const affectsAuthRecovery = (event: OrchestrationV2DomainEvent) =>
  event.type.startsWith("thread.") ||
  event.type === "run.created" ||
  event.type === "run.updated" ||
  event.type === "runtime-request.updated" ||
  event.type.startsWith("provider-session.") ||
  (event.type === "turn-item.updated" && event.payload.type === "error");

const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStoreService.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const analytics = yield* AnalyticsService.AnalyticsService;
  const record = (action: "wait" | "resume") =>
    ProviderSignInRecoveryUsage.record(action).pipe(
      Effect.provideService(AnalyticsService.AnalyticsService, analytics),
    );
  const scope = yield* Effect.scope;
  const due = DueHint.make();
  yield* forkParked(
    Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
      affectsAuthRecovery(event) ? due.invalidate : Effect.void,
    ),
  );

  const readSignal = Effect.fn("ProviderAuthRecoveryWorker.readSignal")(function* (
    instanceId: ProviderInstanceId,
  ) {
    const instance = yield* registry.getInstance(instanceId);
    if (!instance) return null;
    const snapshot = yield* instance.snapshot.getSnapshot;
    return {
      status: snapshot.auth.status,
      signedInAtMs: instance.auth?.lastSignedInAt ? yield* instance.auth.lastSignedInAt : null,
      credentialsChangedAtMs: instance.credentialsChangedAt
        ? yield* instance.credentialsChangedAt
        : null,
    } satisfies ProviderSignInSignal;
  });

  // The failed process keeps its stale credentials, and would fail the resumed turn too.
  const releaseIdleSessions = Effect.fn("ProviderAuthRecoveryWorker.releaseIdleSessions")(
    function* (thread: ProjectionStore.ProjectionAuthRecoveryCandidate) {
      const { providerSessions: sessions } = yield* projections.getThreadRecords(thread.id, [
        "providerSessions",
      ]);
      yield* Effect.forEach(
        sessions.filter(
          (session) =>
            session.providerInstanceId === thread.providerInstanceId && session.status === "ready",
        ),
        (session) =>
          Effect.gen(function* () {
            // "ready" says nothing of a shared process's other threads.
            const others = yield* providerSessions.otherWorkingThreads({
              providerSessionId: session.id,
              threadId: thread.id,
            });
            if (others.length > 0) return;
            yield* providerSessions.releaseUnlessBusy({
              providerSessionId: session.id,
              ownProviderThreadIds: [],
              reason: "manual_shutdown",
              detail: "Provider sign-in changed.",
            });
          }),
        { discard: true },
      );
    },
  );

  return Effect.fn("ProviderAuthRecoveryWorker.sweep")(function* () {
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    if (yield* due.isIdle(nowMs)) return;
    const readVersion = yield* due.version;
    const candidates = yield* projections.getAuthRecoveryCandidates();
    const signals = new Map<ProviderInstanceId, ProviderSignInSignal | null>();
    const armedInstances = new Set<ProviderInstanceId>();
    const refreshedInstances = new Set<ProviderInstanceId>();
    let acted = false;
    for (const thread of candidates) {
      if (!signals.has(thread.providerInstanceId)) {
        signals.set(thread.providerInstanceId, yield* readSignal(thread.providerInstanceId));
      }
      const signal = signals.get(thread.providerInstanceId);
      if (!signal) continue;
      const command = authRecoveryCommand(thread, signal, nowMs);
      if (command === null) continue;
      acted = true;
      yield* Effect.gen(function* () {
        if (command.type === "thread.metadata.update" && command.authRecovery !== undefined) {
          if (thread.authRecovery?.runId === command.authRecovery.runId) {
            yield* orchestrator.dispatch(command);
          } else {
            yield* orchestrator.autoArmAuthRecovery({
              commandId: command.commandId,
              threadId: command.threadId,
              authRecovery: command.authRecovery,
            });
            armedInstances.add(thread.providerInstanceId);
            yield* record("wait");
          }
        } else {
          // A status from before this sign-in would read as signed out when the resumed run's
          // failure is armed, and a later refresh would then look like a second sign-in.
          if (!refreshedInstances.has(thread.providerInstanceId)) {
            refreshedInstances.add(thread.providerInstanceId);
            const instance = yield* registry.getInstance(thread.providerInstanceId);
            if (instance) yield* instance.snapshot.refresh;
          }
          yield* releaseIdleSessions(thread).pipe(Effect.ignoreCause({ log: true }));
          yield* threads.dispatch(command);
          yield* record("resume");
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.auth-recovery.dispatch-failed", {
            threadId: thread.id,
            cause,
          }),
        ),
      );
    }
    // The failure usually arrives before the status check notices. Ask now, so it can be seen
    // signed out and then signed in again rather than only ever reading as signed in.
    for (const instanceId of armedInstances) {
      const instance = yield* registry.getInstance(instanceId);
      if (instance) {
        yield* instance.snapshot.refresh.pipe(
          Effect.ignoreCause({ log: true }),
          Effect.forkIn(scope),
        );
      }
    }
    if (acted) return;
    yield* due.record(
      readVersion,
      candidates.length === 0 ? Infinity : nowMs + CHECK_WHILE_WAITING_MS,
      nowMs,
    );
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("provider-auth-recovery", sweep());
  }),
);
