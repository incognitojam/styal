import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  ProjectId,
  ProjectNoticeId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";

export const PROJECT_NOTICE_TITLE_MAX_LENGTH = 120;
export const PROJECT_NOTICE_BODY_MAX_LENGTH = 2000;
export const PROJECT_NOTICE_DEFAULT_EXPIRY_HOURS = 24;
export const PROJECT_NOTICE_MAX_EXPIRY_HOURS = 168;
/** Active notices a project may hold at once, so agents cannot flood new threads. */
export const PROJECT_NOTICE_MAX_ACTIVE = 20;

/**
 * A short-lived message an agent leaves for the other threads in a project.
 * Notices expire on their own; a resolved notice is deleted.
 */
export const ProjectNotice = Schema.Struct({
  id: ProjectNoticeId,
  projectId: ProjectId,
  title: Schema.String,
  body: Schema.String,
  authorThreadId: Schema.NullOr(ThreadId),
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
});
export type ProjectNotice = typeof ProjectNotice.Type;

export const ProjectNoticeTitle = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PROJECT_NOTICE_TITLE_MAX_LENGTH),
);
export const ProjectNoticeBody = TrimmedString.check(
  Schema.isMaxLength(PROJECT_NOTICE_BODY_MAX_LENGTH),
);
export const ProjectNoticeExpiryHours = Schema.Number.check(
  Schema.isBetween({ minimum: 0.25, maximum: PROJECT_NOTICE_MAX_EXPIRY_HOURS }),
);

export const ProjectNoticeListInput = Schema.Struct({ projectId: ProjectId });
export type ProjectNoticeListInput = typeof ProjectNoticeListInput.Type;

export const ProjectNoticeListResult = Schema.Struct({
  notices: Schema.Array(ProjectNotice),
});
export type ProjectNoticeListResult = typeof ProjectNoticeListResult.Type;

export const ProjectNoticeResolveInput = Schema.Struct({ noticeId: ProjectNoticeId });
export type ProjectNoticeResolveInput = typeof ProjectNoticeResolveInput.Type;

export const ProjectNoticeResolveResult = Schema.Struct({
  wasActive: Schema.Boolean,
});
export type ProjectNoticeResolveResult = typeof ProjectNoticeResolveResult.Type;

export class ProjectNoticeError extends Schema.TaggedError<ProjectNoticeError>()(
  "ProjectNoticeError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
