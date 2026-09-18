import {
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  type HostActivity,
  type OrchestrationThreadShell,
  type ProviderSession,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { requireEnvironmentScope, failEnvironmentInternal } from "../auth/http.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { TerminalManager } from "../terminal/Manager.ts";

export function summarizeHostSessions(
  threads: ReadonlyArray<
    Pick<
      OrchestrationThreadShell,
      | "id"
      | "session"
      | "latestTurn"
      | "hasPendingApprovals"
      | "hasPendingUserInput"
      | "backgroundLiveness"
    >
  >,
  sessions: ReadonlyArray<Pick<ProviderSession, "threadId" | "status" | "activeTurnId">>,
): Pick<HostActivity, "activeSessions" | "waitingSessions"> {
  const active = new Set<string>();
  const waiting = new Set<string>();
  for (const session of sessions) {
    if (session.status === "connecting" || session.status === "running" || session.activeTurnId) {
      active.add(session.threadId);
    }
  }
  for (const thread of threads) {
    if (thread.hasPendingApprovals || thread.hasPendingUserInput) waiting.add(thread.id);
    if (
      thread.session?.status === "starting" ||
      thread.session?.status === "running" ||
      thread.session?.activeTurnId ||
      thread.latestTurn?.state === "running" ||
      thread.backgroundLiveness
    ) {
      active.add(thread.id);
    }
  }
  for (const id of waiting) active.delete(id);
  return { activeSessions: active.size, waitingSessions: waiting.size };
}

export const inspectHostActivity = Effect.gen(function* () {
  const projection = yield* ProjectionSnapshotQuery;
  const providers = yield* ProviderService;
  const terminals = yield* TerminalManager;
  const terminalActivity = yield* terminals.shutdownPreflight;
  const snapshot = yield* projection.getShellSnapshot();
  const sessions = yield* providers.listSessions();
  return { ...summarizeHostSessions(snapshot.threads, sessions), ...terminalActivity };
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
