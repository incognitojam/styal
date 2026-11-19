import {
  type EnvironmentId,
  type OrchestrationV2ThreadReportTarget,
  type ProjectId,
  projectCoordinatorThreadId,
  type ServerSettings,
  type ServerSettingsPatch,
  type ThreadId,
} from "@t3tools/contracts";

/**
 * `environmentId:projectId:threadId` for each project coordinator in one environment's settings.
 * A thread matches by its own project, since a named thread may later exist in another one.
 */
export function projectCoordinatorKeys(
  environmentId: EnvironmentId,
  settings: Pick<ServerSettings, "projectCoordinatorsEnabled" | "projectCoordinators">,
): string[] {
  if (!settings.projectCoordinatorsEnabled) return [];
  return Object.entries(settings.projectCoordinators).map(
    ([projectId, coordinator]) => `${environmentId}:${projectId}:${coordinator.threadId}`,
  );
}

/**
 * The recipient to show for a thread: a project coordinator listed in another project receives
 * nothing from the server, so none is shown. `recipientProjectId` is null while it is not listed.
 */
export function shownReportRecipientId(
  thread: {
    readonly projectId: ProjectId;
    readonly reportTo?: OrchestrationV2ThreadReportTarget | null | undefined;
  },
  recipientId: ThreadId | null,
  recipientProjectId: ProjectId | null,
): ThreadId | null {
  return recipientId !== null &&
    thread.reportTo?.source === "project-coordinator" &&
    recipientProjectId !== null &&
    recipientProjectId !== thread.projectId
    ? null
    : recipientId;
}

/** Makes `threadId` its project's coordinator, or clears the project's coordinator with null. */
export function projectCoordinatorPatch(
  projectId: ProjectId,
  threadId: ThreadId | null,
): ServerSettingsPatch {
  return { projectCoordinators: { [projectId]: threadId === null ? null : { threadId } } };
}

/** Marks the project's page seen at `seenAt`, keeping its coordinator. */
export function projectSeenPatch(
  projectId: ProjectId,
  threadId: ThreadId,
  seenAt: string,
): ServerSettingsPatch {
  return { projectCoordinators: { [projectId]: { threadId, seenAt } } };
}

/** The thread a thread's reports go to now, as its environment's settings name it. */
export function reportRecipientId(
  thread: {
    readonly id: ThreadId;
    readonly projectId: ProjectId;
    readonly reportTo?: OrchestrationV2ThreadReportTarget | null | undefined;
  },
  settings: Pick<ServerSettings, "projectCoordinatorsEnabled" | "projectCoordinators"> | undefined,
): ThreadId | null {
  const target = thread.reportTo;
  if (target == null) return null;
  const recipient =
    target.source !== "project-coordinator"
      ? target.threadId
      : settings === undefined
        ? null
        : projectCoordinatorThreadId(settings, thread.projectId);
  return recipient === thread.id ? null : recipient;
}
