import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** The automatic roles a styal.json action can ask for. */
export const ProjectFileActionRole = Schema.Literals(["setup", "settle"]);
export type ProjectFileActionRole = typeof ProjectFileActionRole.Type;

/**
 * The user's approval of one styal.json action: the exact command they saw
 * and the roles it may run in. A file action only runs on its own while its
 * command is still this one and it asks for no role beyond these.
 */
export const ProjectFileActionApproval = Schema.Struct({
  command: TrimmedNonEmptyString,
  roles: Schema.Array(ProjectFileActionRole),
  approvedAt: IsoDateTime,
});
export type ProjectFileActionApproval = typeof ProjectFileActionApproval.Type;

/**
 * Approvals keyed by repository (see `projectFileApprovalKey`), then action
 * id. Keyed by repository rather than by machine-local project so the same
 * repository's approvals can follow the user across environments later.
 */
export const ProjectFileActionApprovals = Schema.Record(
  Schema.String,
  Schema.Record(Schema.String, ProjectFileActionApproval),
);
export type ProjectFileActionApprovals = typeof ProjectFileActionApprovals.Type;

/**
 * What an approval would cover, read by the server from the project root
 * so the client never supplies the command it approves.
 *
 * `hint` names files the command runs, whose later edits run without asking
 * again: a best-effort reading of the command, never a security check.
 */
export const ProjectFileActionReview = Schema.Struct({
  actionId: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  command: TrimmedNonEmptyString,
  roles: Schema.Array(ProjectFileActionRole),
  approved: Schema.NullOr(ProjectFileActionApproval),
  hint: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("files"), paths: Schema.Array(Schema.String) }),
    Schema.Struct({ kind: Schema.Literal("package-script"), script: Schema.String }),
    Schema.Struct({ kind: Schema.Literal("none") }),
  ]),
});
export type ProjectFileActionReview = typeof ProjectFileActionReview.Type;

export const ProjectFileActionApprovalInput = Schema.Struct({
  projectId: ProjectId,
  actionId: TrimmedNonEmptyString,
});
export type ProjectFileActionApprovalInput = typeof ProjectFileActionApprovalInput.Type;

export class ProjectFileActionApprovalError extends Schema.TaggedError<ProjectFileActionApprovalError>()(
  "ProjectFileActionApprovalError",
  {
    reason: Schema.Literals([
      "project-not-found",
      "action-not-found",
      "nothing-to-approve",
      "save-failed",
    ]),
    message: Schema.String,
  },
) {}
