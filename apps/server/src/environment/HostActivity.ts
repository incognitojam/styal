import {
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  OrchestrationV2GetShellSnapshotError,
  type HostActivity,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { requireEnvironmentScope, failEnvironmentInternal } from "../auth/http.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { listContinuableThreadIds } from "../orchestration-v2/ProviderRuntimeRecoveryService.ts";
import { TerminalManager } from "../terminal/Manager.ts";

type HostThread = Pick<
  OrchestrationV2ThreadShell,
  "id" | "status" | "pendingRuntimeRequest" | "pendingBackgroundTasks"
>;

export function summarizeHostSessions(
  threads: ReadonlyArray<HostThread>,
  continuableThreadIds: ReadonlySet<string> = new Set(),
): Pick<HostActivity, "activeSessions" | "continuableSessions" | "waitingSessions"> {
  const active = new Set<string>();
  const waiting = new Set<string>();
  for (const thread of threads) {
    if (thread.pendingRuntimeRequest !== null || thread.status === "waiting") {
      waiting.add(thread.id);
    } else if (
      ["preparing", "starting", "running"].includes(thread.status) ||
      (thread.pendingBackgroundTasks?.length ?? 0) > 0
    ) {
      active.add(thread.id);
    }
  }
  return {
    activeSessions: active.size,
    continuableSessions: [...active].filter((id) => continuableThreadIds.has(id)).length,
    waitingSessions: waiting.size,
  };
}

export const inspectHostActivity = Effect.gen(function* () {
  const projections = yield* ProjectionStoreV2;
  const terminals = yield* TerminalManager;
  const terminalActivity = yield* terminals.shutdownPreflight;
  const snapshot = yield* projections.getShellSnapshot().pipe(
    Effect.mapError(
      (cause) =>
        new OrchestrationV2GetShellSnapshotError({
          message: "Failed to read thread activity",
          cause,
        }),
    ),
  );
  const continuable = yield* listContinuableThreadIds.pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("could not read continuable threads", { cause }).pipe(
        Effect.as(new Set<string>()),
      ),
    ),
  );
  return { ...summarizeHostSessions(snapshot.threads, continuable), ...terminalActivity };
});

export const hostActivityHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "activity",
  (handlers) =>
    handlers.handle("get", () =>
      Effect.gen(function* () {
        yield* requireEnvironmentScope(AuthOrchestrationReadScope);
        return yield* inspectHostActivity.pipe(
          Effect.catch((cause) => failEnvironmentInternal("host_activity_failed", cause)),
        );
      }),
    ),
);
