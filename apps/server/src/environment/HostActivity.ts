import {
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  OrchestrationV2GetShellSnapshotError,
  type HostActivity,
  type HostActivityThread,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { requireEnvironmentScope, failEnvironmentInternal } from "../auth/http.ts";
import { DeviceSharing } from "../device/DeviceSharing.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import { listContinuableThreadIds } from "../orchestration-v2/ProviderRuntimeRecoveryService.ts";
import { TerminalManager } from "../terminal/Manager.ts";

type HostThread = Pick<
  OrchestrationV2ThreadShell,
  "id" | "title" | "projectId" | "status" | "pendingRuntimeRequest" | "pendingBackgroundTasks"
>;

export function summarizeHostSessions(
  threads: ReadonlyArray<HostThread>,
  continuableThreadIds: ReadonlySet<string> = new Set(),
  projectTitles: ReadonlyMap<string, string> = new Map(),
): Pick<HostActivity, "activeSessions" | "continuableSessions" | "waitingSessions" | "threads"> {
  const active = new Set<string>();
  const waiting = new Set<string>();
  const affected = new Map<string, HostActivityThread>();
  for (const thread of threads) {
    const reasons: HostActivityThread["reasons"][number][] = [];
    if (thread.pendingRuntimeRequest !== null || thread.status === "waiting") {
      waiting.add(thread.id);
      const kind = thread.pendingRuntimeRequest?.kind;
      reasons.push(
        kind === "user_input" || kind === "mcp-elicitation"
          ? "input"
          : kind === "command" ||
              kind === "file-read" ||
              kind === "file-change" ||
              kind === "permission"
            ? "approval"
            : "waiting",
      );
    } else if (
      ["preparing", "starting", "running"].includes(thread.status) ||
      (thread.pendingBackgroundTasks?.length ?? 0) > 0
    ) {
      active.add(thread.id);
      if (
        thread.status === "preparing" ||
        thread.status === "starting" ||
        thread.status === "running"
      ) {
        reasons.push(thread.status);
      }
    }
    for (const task of thread.pendingBackgroundTasks ?? []) {
      if (!reasons.includes(task.kind)) reasons.push(task.kind);
    }
    if (reasons.length === 0) continue;
    affected.set(thread.id, {
      threadId: thread.id,
      title: thread.title,
      projectTitle: projectTitles.get(thread.projectId) ?? null,
      reasons,
      continuable: active.has(thread.id) && continuableThreadIds.has(thread.id),
    });
  }
  return {
    activeSessions: active.size,
    continuableSessions: [...active].filter((id) => continuableThreadIds.has(id)).length,
    waitingSessions: waiting.size,
    threads: [...affected.values()],
  };
}

export const inspectHostActivity = Effect.gen(function* () {
  const projections = yield* ProjectionStoreV2;
  const terminals = yield* TerminalManager;
  const terminalActivity = yield* terminals.shutdownPreflight;
  // Threads using a shared device run on the other environment, so their activity is
  // invisible here. A restart stops the hub and daemon they are driving.
  const environmentsUsingDevices = yield* (yield* DeviceSharing).environmentsUsingDevices;
  const { snapshot, projects } = yield* Effect.all({
    snapshot: projections.getShellSnapshot(),
    projects: (yield* ProjectStoreV2).list(),
  }).pipe(
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
  return {
    ...summarizeHostSessions(
      snapshot.threads,
      continuable,
      new Map(projects.map((project) => [project.projectId, project.title])),
    ),
    ...terminalActivity,
    environmentsUsingDevices,
  };
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
