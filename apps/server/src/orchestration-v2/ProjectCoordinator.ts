import {
  type OrchestrationV2ThreadReportTarget,
  type ProjectId,
  projectCoordinatorThreadId,
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

/**
 * Sent with every session of a project's coordinator, the way the project's Additional
 * instructions are, so a context summary cannot drop it. The long form is the orchestration guide.
 */
export const projectCoordinatorInstructions = (reports: boolean) =>
  [
    "## Coordinating this project",
    "",
    "You coordinate this project in styal, and threads started in it report to you.",
    "- Do not edit files or make changes yourself. Hand every change, however small, to another thread with `t3_thread_launch` or `create_threads` and `reportBack`, without waiting to be asked for a thread: here that replaces the rule that those tools are only for threads the user asks for. Give each a brief that stands on its own. Read and answer questions yourself.",
    "- Do not poll threads or relay their questions: styal reports results, failures and blocked requests to you, and the user answers in the thread or on the project page.",
    `- Mention threads by their link${reports ? ", put decisions the user must make in a `t3_report`" : ""}, and have another thread review non-trivial changes.`,
    '- Make a change yourself only when the user says so in as many words, such as "do it yourself" or "not in a thread". A request to fix or change something is not that.',
    "",
    "The `orchestration` guide has more.",
  ].join("\n");
