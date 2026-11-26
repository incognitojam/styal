import { listContinuableThreadIds } from "../orchestration-v2/ProviderRuntimeRecoveryService.ts";
import {
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  OrchestrationV2GetShellSnapshotError,
  type HostActivity,
  type HostActivityThread,
  type ProjectId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { isPullRequestWatchTask } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { requireEnvironmentScope, failEnvironmentInternal } from "../auth/http.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { ProjectStoreV2, type ProjectRow } from "../orchestration-v2/ProjectStore.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import { ServerEnvironmentIdentity } from "./ServerEnvironment.ts";

type HostThread = Pick<
  OrchestrationV2ThreadShell,
  "id" | "title" | "projectId" | "status" | "pendingRuntimeRequest" | "pendingBackgroundTasks"
>;

type HostProject = Pick<
  ProjectRow,
  "projectId" | "title" | "workspaceRoot" | "faviconPath" | "projectIcon"
>;

type AffectedThread = {
  readonly projectId: ProjectId;
  readonly thread: HostActivityThread;
};

function stoppableBackgroundTasks(thread: HostThread) {
  return (thread.pendingBackgroundTasks ?? []).filter(
    (task) =>
      !isPullRequestWatchTask(task) &&
      !(
        task.kind === "subagent" &&
        task.origin === "app_owned" &&
        task.childThreadId !== undefined
      ),
  );
}

function isActiveHostThread(thread: HostThread): boolean {
  if (thread.pendingRuntimeRequest !== null || thread.status === "waiting") return false;
  return (
    thread.status === "preparing" ||
    thread.status === "starting" ||
    thread.status === "running" ||
    stoppableBackgroundTasks(thread).length > 0
  );
}

/** Counts the work a restart would stop and lists each affected thread once. */
export function summarizeHostSessions(
  threads: ReadonlyArray<HostThread>,
  continuableThreadIds: ReadonlySet<string> = new Set(),
) {
  let activeSessions = 0;
  let continuableSessions = 0;
  let waitingSessions = 0;
  const affected: AffectedThread[] = [];
  for (const thread of threads) {
    const reasons: HostActivityThread["reasons"][number][] = [];
    const active = isActiveHostThread(thread);
    if (thread.pendingRuntimeRequest !== null || thread.status === "waiting") {
      waitingSessions += 1;
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
      thread.status === "preparing" ||
      thread.status === "starting" ||
      thread.status === "running"
    ) {
      reasons.push(thread.status);
    }
    for (const task of stoppableBackgroundTasks(thread)) {
      if (!reasons.includes(task.kind)) reasons.push(task.kind);
    }
    if (reasons.length === 0) continue;
    const continuable = active && continuableThreadIds.has(thread.id);
    if (active) activeSessions += 1;
    if (continuable) continuableSessions += 1;
    affected.push({
      projectId: thread.projectId,
      thread: { threadId: thread.id, title: thread.title, reasons, continuable },
    });
  }
  return { activeSessions, continuableSessions, waitingSessions, affected };
}

/** Adds saved project identity to affected threads whose project still exists. */
export function withProjects(
  affected: ReadonlyArray<AffectedThread>,
  projects: ReadonlyArray<HostProject>,
): ReadonlyArray<HostActivityThread> {
  const projectsById = new Map(projects.map((project) => [project.projectId, project]));
  return affected.map(({ projectId, thread }) => {
    const project = projectsById.get(projectId);
    return project
      ? {
          ...thread,
          project: {
            id: projectId,
            title: project.title,
            workspaceRoot: project.workspaceRoot,
            faviconPath: project.faviconPath,
            projectIcon: project.projectIcon,
          },
        }
      : thread;
  });
}

const readFailed = (cause: unknown) =>
  new OrchestrationV2GetShellSnapshotError({ message: "Failed to read thread activity", cause });

export const inspectHostActivity = Effect.gen(function* () {
  const environmentId = yield* (yield* ServerEnvironmentIdentity).getEnvironmentId;
  const projections = yield* ProjectionStoreV2;
  const projectStore = yield* ProjectStoreV2;
  const terminals = yield* TerminalManager;
  const terminalActivity = yield* terminals.shutdownPreflight;
  // Run it off the event loop: even a snapshot read can wait on a cold page cache.
  const snapshot = yield* projections
    .getShellSnapshot({ location: "active", busyOnly: true })
    .pipe(NodeSqliteClient.readOnly, Effect.mapError(readFailed));
  const continuable = yield* listContinuableThreadIds(
    snapshot.threads.filter(isActiveHostThread),
  ).pipe(NodeSqliteClient.readOnly, Effect.mapError(readFailed));
  const { affected, ...counts } = summarizeHostSessions(snapshot.threads, continuable);
  const projectIds = [...new Set(affected.map((item) => item.projectId))];
  const projects =
    projectIds.length === 0
      ? []
      : yield* projectStore.list({ projectIds }).pipe(Effect.mapError(readFailed));
  return {
    environmentId,
    ...counts,
    threads: withProjects(affected, projects),
    ...terminalActivity,
  } satisfies HostActivity;
});

export const hostActivityHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "activity",
  Effect.fnUntraced(function* (handlers) {
    const context = yield* Effect.context<Effect.Services<typeof inspectHostActivity>>();
    return handlers.handle("get", () =>
      Effect.gen(function* () {
        yield* requireEnvironmentScope(AuthOrchestrationReadScope);
        return yield* inspectHostActivity.pipe(
          Effect.provideContext(context),
          Effect.catch((cause) => failEnvironmentInternal("host_activity_failed", cause)),
        );
      }),
    );
  }),
);
