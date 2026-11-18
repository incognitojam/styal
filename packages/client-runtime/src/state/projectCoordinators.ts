import {
  type EnvironmentId,
  type OrchestrationV2ThreadReportTarget,
  type ProjectId,
  projectCoordinatorThreadId,
  type ServerSettings,
  type ServerSettingsPatch,
  type ThreadId,
} from "@t3tools/contracts";

/** `environmentId:threadId` for each project coordinator in one environment's settings. */
export function projectCoordinatorKeys(
  environmentId: EnvironmentId,
  settings: Pick<ServerSettings, "projectCoordinatorsEnabled" | "projectCoordinators">,
): string[] {
  if (!settings.projectCoordinatorsEnabled) return [];
  return Object.values(settings.projectCoordinators).map(
    (coordinator) => `${environmentId}:${coordinator.threadId}`,
  );
}

/** Makes `threadId` its project's coordinator, or clears the project's coordinator with null. */
export function projectCoordinatorPatch(
  projectId: ProjectId,
  threadId: ThreadId | null,
): ServerSettingsPatch {
  return { projectCoordinators: { [projectId]: threadId === null ? null : { threadId } } };
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
