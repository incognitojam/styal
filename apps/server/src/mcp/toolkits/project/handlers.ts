import { MessageId, ThreadId, OrchestratorMcpFailure, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ThreadMessageIntake from "../../../orchestration-v2/ThreadMessageIntake.ts";
import * as Claims from "../../../orchestration-v2/AttachmentClaims.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as ProjectNotices from "../../../project/ProjectNotices.ts";
import * as FeatureUsage from "../../../telemetry/FeatureUsage.ts";
import * as Repositories from "../../../sourceControl/SourceControlRepositoryService.ts";
import { resolveRuntimeMode } from "../../OrchestratorMcpService.ts";
import {
  newCommandId,
  readCaller,
  readFullAccessCaller,
  readMutationCaller,
  resolveProjectId,
  unavailable,
} from "../../threadAccess.ts";
import { ProjectToolkit } from "./tools.ts";

function projectFailure(error: Project.ProjectServiceError) {
  if (error._tag === "ProjectOperationError") return unavailable();
  const message =
    error._tag === "ProjectNotFoundError"
      ? "The project was not found."
      : error._tag === "ProjectConflictError"
        ? "The workspace is already registered to a project."
        : "The project is not empty; force=true is required to delete it.";
  return new OrchestratorMcpFailure({ code: "invalid_request", message });
}

function noticeFailure(error: { readonly message: string; readonly cause?: unknown }) {
  // A notice error without a cause is a rule the caller can fix, such as the active limit.
  return error.cause === undefined
    ? new OrchestratorMcpFailure({ code: "invalid_request", message: error.message })
    : unavailable();
}

/**
 * The project a notice tool acts on: the one passed, which must exist, else the caller's.
 * Posting needs the calling thread's live run, like other mutations; listing does not.
 */
const noticeProject = Effect.fn("mcp.noticeProject")(function* (
  projectId: ProjectId | undefined,
  access: "read" | "mutate",
) {
  const context = yield* access === "mutate" ? readMutationCaller() : readCaller();
  const resolved = yield* resolveProjectId(context, projectId);
  if (projectId !== undefined) {
    const project = yield* Project.ProjectService.pipe(
      Effect.flatMap((projects) => projects.getById(projectId)),
      Effect.mapError(unavailable),
    );
    if (Option.isNone(project))
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "The project was not found.",
      });
  }
  return { projectId: resolved, authorThreadId: context.caller?.id ?? null };
});

const access = Effect.gen(function* () {
  yield* readCaller();
  return yield* Project.ProjectService;
});
const mutation = Effect.gen(function* () {
  yield* readFullAccessCaller(
    "Project changes require a live full-access/default calling thread or a full-access client.",
  );
  return yield* Project.ProjectService;
});
export const layer = ProjectToolkit.toLayer({
  t3_thread_launch: (input) =>
    Effect.gen(function* () {
      const context = yield* readMutationCaller();
      const { caller, limits } = context;
      // A thread caller launches only as itself (full-access/default), as before. A client
      // launches anything up to its ceiling.
      if (
        caller !== undefined &&
        (caller.runtimeMode !== "full-access" || caller.interactionMode !== "default")
      )
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Project launches require a full-access/default calling thread.",
        });
      const runtimeMode = yield* resolveRuntimeMode(
        limits.runtimeMode,
        input.runtimeMode ?? caller?.runtimeMode,
      );
      const commandId = yield* newCommandId();
      const threadId = ThreadId.make(commandId);
      const messageId = MessageId.make(commandId);
      const attachments = input.attachments ?? [];
      if (attachments.some((attachment) => !Claims.attachmentIsPendingUpload(attachment)))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "A new thread accepts only pending attachment uploads.",
        });
      if (
        input.scratch === true &&
        (input.projectId !== undefined || input.workspaceStrategy !== undefined)
      )
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            "scratch:true picks its own project and folder; omit projectId and workspaceStrategy.",
        });
      const projectId =
        input.scratch === true
          ? (yield* ManagedProjectFolders.ManagedProjectFolders.pipe(
              Effect.flatMap((folders) => folders.ensureScratchProject),
              Effect.mapError(
                (error) =>
                  new OrchestratorMcpFailure({
                    code: "orchestration_error",
                    message: error.message,
                  }),
              ),
            )).projectId
          : yield* resolveProjectId(context, input.projectId);
      const modelSelection =
        input.modelSelection ??
        caller?.modelSelection ??
        (yield* Project.ProjectService.pipe(
          Effect.flatMap((projects) => projects.getById(projectId)),
          Effect.mapError(unavailable),
          Effect.map((project) =>
            Option.getOrUndefined(Option.flatMapNullishOr(project, (p) => p.defaultModelSelection)),
          ),
        ));
      if (modelSelection === undefined)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            "Pass modelSelection: the project has no default model. orchestrator_capabilities lists providers and models.",
        });
      const result = yield* ThreadMessageIntake.launchThread({
        commandId,
        threadId,
        projectId,
        title: input.title,
        modelSelection,
        runtimeMode,
        interactionMode: input.interactionMode ?? caller?.interactionMode ?? "default",
        workspaceStrategy: input.workspaceStrategy ?? { type: "root" },
        ...(input.message === undefined && attachments.length === 0
          ? {}
          : {
              initialMessage: {
                messageId,
                ...(caller === undefined ? {} : { senderThreadId: caller.id }),
                text: input.message ?? "",
                attachments,
              },
            }),
        createdBy: "agent",
        creationSource: "mcp",
      }).pipe(
        Effect.mapError((error) =>
          error._tag === "AttachmentClaimError"
            ? new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message })
            : unavailable(),
        ),
      );
      const thread = result.projection.thread;
      const run = result.projection.runs.find((run) => run.userMessageId === messageId);
      return {
        threadId: thread.id,
        projectId: thread.projectId,
        modelSelection: thread.modelSelection,
        runId: run?.id ?? null,
        status: run?.status ?? null,
      };
    }),
  t3_project_list: (input) =>
    Effect.gen(function* () {
      const projects = yield* access;
      const snapshot = yield* projects.snapshot.pipe(Effect.mapError(unavailable));
      const rows = snapshot.projects.filter((project) => project.deletedAt === null);
      const start = input.cursor ?? 0,
        end = start + (input.limit ?? 20);
      return { projects: rows.slice(start, end), nextCursor: end < rows.length ? end : null };
    }),
  t3_project_read: (input) =>
    Effect.gen(function* () {
      const projects = yield* access;
      const result = yield* projects.getById(input.projectId).pipe(Effect.mapError(unavailable));
      if (Option.isNone(result))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The project was not found.",
        });
      return result.value;
    }),
  t3_project_create: ({ workspaceRoot, ...input }) =>
    Effect.gen(function* () {
      const projects = yield* mutation;
      if (workspaceRoot === undefined) {
        // Project creation records no model default (only an update does), so
        // reject what this mode would otherwise drop silently.
        if (
          input.scripts !== undefined ||
          input.createWorkspaceRootIfMissing !== undefined ||
          input.defaultModelSelection !== undefined
        )
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message:
              "A project started from its title takes only a title; set scripts or defaultModelSelection afterwards with t3_project_update.",
          });
        const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
        const created = yield* folders
          .createNamedProject({ name: input.title })
          .pipe(
            Effect.mapError(
              (error) =>
                new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
            ),
          );
        const project = yield* projects
          .getById(created.projectId)
          .pipe(
            Effect.mapError(unavailable),
            Effect.flatMap(
              Option.match({ onNone: () => Effect.fail(unavailable()), onSome: Effect.succeed }),
            ),
          );
        return {
          ...project,
          ...(created.commitError === undefined ? {} : { commitError: created.commitError }),
        };
      }
      const commandId = yield* newCommandId();
      return yield* projects
        .create({ ...input, workspaceRoot, commandId, projectId: ProjectId.make(commandId) })
        .pipe(Effect.mapError(projectFailure));
    }),
  t3_project_update: (input) =>
    Effect.gen(function* () {
      const projects = yield* mutation;
      return yield* projects
        .update({ ...input, commandId: yield* newCommandId() })
        .pipe(Effect.mapError(projectFailure));
    }),
  t3_project_delete: (input) =>
    Effect.gen(function* () {
      const projects = yield* mutation;
      return yield* projects
        .delete({ ...input, commandId: yield* newCommandId() })
        .pipe(Effect.mapError(projectFailure));
    }),
  t3_project_clone: (input) =>
    Effect.gen(function* () {
      yield* mutation;
      const repositories = yield* Repositories.SourceControlRepositoryService;
      return yield* repositories.cloneRepository(input).pipe(
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: error.detail,
            }),
        ),
      );
    }),
  t3_notice_post: (input) =>
    FeatureUsage.observe(
      { feature: "notices", action: "post", source: "agent" },
      Effect.gen(function* () {
        const { projectId, authorThreadId } = yield* noticeProject(input.projectId, "mutate");
        const notices = yield* ProjectNotices.ProjectNotices;
        return yield* notices
          .post({
            projectId,
            authorThreadId,
            title: input.title,
            body: input.body ?? "",
            expiresInHours: input.expiresInHours,
          })
          .pipe(Effect.mapError(noticeFailure));
      }),
    ),
  t3_notice_list: (input) =>
    FeatureUsage.observe(
      { feature: "notices", action: "list", source: "agent" },
      Effect.gen(function* () {
        const { projectId } = yield* noticeProject(input.projectId, "read");
        const notices = yield* ProjectNotices.ProjectNotices;
        return yield* notices.list(projectId).pipe(Effect.mapError(noticeFailure));
      }),
    ),
  t3_notice_resolve: (input) =>
    FeatureUsage.observe(
      { feature: "notices", action: "resolve", source: "agent" },
      Effect.gen(function* () {
        yield* readMutationCaller();
        const notices = yield* ProjectNotices.ProjectNotices;
        return yield* notices.resolve(input.noticeId).pipe(Effect.mapError(noticeFailure));
      }),
    ),
});
