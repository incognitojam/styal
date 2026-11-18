import {
  type OrchestrationV2ThreadReportTarget,
  type ProjectId,
  projectCoordinatorThreadId,
  type RunId,
  type ServerSettings,
  ServerSettingsError,
  type ServerSettingsPatch,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

export interface ProjectCoordinatorLookup<SettingsError, ShellError> {
  readonly settings: Effect.Effect<
    Pick<ServerSettings, "projectCoordinatorsEnabled" | "projectCoordinators">,
    SettingsError
  >;
  readonly getThreadShell: (
    threadId: ThreadId,
  ) => Effect.Effect<
    { readonly projectId: ProjectId; readonly deletedAt: unknown } | null,
    ShellError
  >;
}

/** The project's coordinator, only while it is a thread of that project that still exists. */
export const currentProjectCoordinator = Effect.fn("ProjectCoordinator.current")(function* <
  SettingsError,
  ShellError,
>(lookup: ProjectCoordinatorLookup<SettingsError, ShellError>, projectId: ProjectId) {
  const settings = yield* lookup.settings.pipe(Effect.orElseSucceed(() => null));
  const threadId = settings === null ? null : projectCoordinatorThreadId(settings, projectId);
  if (threadId === null) return null;
  const shell = yield* lookup.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
  return shell !== null && shell.deletedAt === null && shell.projectId === projectId
    ? threadId
    : null;
});

/**
 * Refuses a coordinator that is a thread of another project, or a deleted one. A thread that does
 * not exist yet is accepted, so a new project chat is named before its first turn starts; until it
 * exists, `currentProjectCoordinator` treats the project as having none.
 */
export const assertProjectCoordinatorsBelong = Effect.fn("ProjectCoordinator.assertBelong")(
  function* <ShellError>(
    getThreadShell: ProjectCoordinatorLookup<never, ShellError>["getThreadShell"],
    patch: Pick<ServerSettingsPatch, "projectCoordinators">,
  ) {
    for (const [projectId, coordinator] of Object.entries(patch.projectCoordinators ?? {})) {
      if (coordinator === null) continue;
      const refused = new ServerSettingsError({
        settingsPath: `projectCoordinators.${projectId}`,
        operation: "set-project-coordinator",
      });
      // Only a lookup that found no thread accepts it; a failed lookup refuses.
      const shell = yield* getThreadShell(coordinator.threadId).pipe(
        Effect.mapError(() => refused),
      );
      if (shell !== null && (shell.deletedAt !== null || shell.projectId !== projectId)) {
        return yield* refused;
      }
    }
  },
);

/**
 * Who a thread's reports go to now: the thread that launched it, or its project's current
 * coordinator. Report checks, the report note, explicit reports and their permission all use it.
 */
export const reportRecipient = Effect.fn("ProjectCoordinator.reportRecipient")(function* <
  SettingsError,
  ShellError,
>(
  lookup: ProjectCoordinatorLookup<SettingsError, ShellError>,
  thread: {
    readonly id: ThreadId;
    readonly projectId: ProjectId;
    readonly reportTo?: OrchestrationV2ThreadReportTarget | null | undefined;
  },
) {
  const target = thread.reportTo;
  if (target == null) return null;
  const recipient =
    target.source === "project-coordinator"
      ? yield* currentProjectCoordinator(lookup, thread.projectId)
      : target.threadId;
  return recipient === thread.id ? null : recipient;
});

const NOTE_ID_PREFIX = "project-coordinator:";

export const PROJECT_COORDINATOR_NOTE =
  "Note: you coordinate this project. Hand work to other threads with `t3_thread_launch` or `t3_thread_send` instead of doing it yourself. Threads started in this project report to you when they finish or need input.";

export const PROJECT_COORDINATOR_ENDED_NOTE =
  "Note: you no longer coordinate this project, and its threads stop reporting to you.";

/**
 * The coordinator note a turn owes: one when the thread becomes the coordinator, and one when it
 * stops, judged from the notes earlier turns carried, oldest first.
 */
export function projectCoordinatorTurnNote(input: {
  readonly isCoordinator: boolean;
  readonly deliveredContextIds: Iterable<string>;
  readonly runId: RunId;
}): { readonly id: string; readonly text: string } | null {
  let told = false;
  for (const id of input.deliveredContextIds) {
    if (id.startsWith(NOTE_ID_PREFIX)) told = id.startsWith(`${NOTE_ID_PREFIX}set:`);
  }
  if (input.isCoordinator === told) return null;
  return input.isCoordinator
    ? { id: `${NOTE_ID_PREFIX}set:${input.runId}`, text: PROJECT_COORDINATOR_NOTE }
    : { id: `${NOTE_ID_PREFIX}ended:${input.runId}`, text: PROJECT_COORDINATOR_ENDED_NOTE };
}
