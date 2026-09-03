import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt } from "./baseSchemas.ts";
import { ServerSettings } from "./settings.ts";

export const LegacyImportSourceKind = Schema.Literals(["t3-code", "t3-code-yngatech"]);
export type LegacyImportSourceKind = typeof LegacyImportSourceKind.Type;

export const LegacyImportUnavailableReason = Schema.Literals([
  "current-database",
  "unsupported-database",
  "unreadable-database",
]);
export type LegacyImportUnavailableReason = typeof LegacyImportUnavailableReason.Type;

const LegacyImportNotFoundPreview = Schema.Struct({
  status: Schema.Literal("not-found"),
});

export const LegacyImportProjectPreview = Schema.Struct({
  projectId: Schema.String,
  title: Schema.String,
  workspaceRoot: Schema.String,
  faviconPath: Schema.NullOr(Schema.String),
  threadCount: NonNegativeInt,
  contextRepairCount: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  scriptCount: NonNegativeInt,
  isExistingProject: Schema.Boolean,
});
export type LegacyImportProjectPreview = typeof LegacyImportProjectPreview.Type;

/** The explicitly allowlisted server preferences that may cross an import boundary. */
export const LegacyImportPreferences = Schema.Struct({
  enableLegacyTokenStreaming: ServerSettings.fields.enableLegacyTokenStreaming,
  enableProviderUpdateChecks: ServerSettings.fields.enableProviderUpdateChecks,
  enableAgentBrowserAccess: ServerSettings.fields.enableAgentBrowserAccess,
  backgroundActivity: ServerSettings.fields.backgroundActivity,
  automaticGitFetchInterval: ServerSettings.fields.automaticGitFetchInterval,
  providerHealthRefreshInterval: ServerSettings.fields.providerHealthRefreshInterval,
  backgroundActivityProfile: ServerSettings.fields.backgroundActivityProfile,
  defaultThreadEnvMode: ServerSettings.fields.defaultThreadEnvMode,
  newWorktreesStartFromOrigin: ServerSettings.fields.newWorktreesStartFromOrigin,
  addProjectBaseDirectory: ServerSettings.fields.addProjectBaseDirectory,
  sourceControlWritingStyle: ServerSettings.fields.sourceControlWritingStyle,
});
export type LegacyImportPreferences = typeof LegacyImportPreferences.Type;

export const LegacyImportPreferencesPreview = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("available"),
    values: LegacyImportPreferences,
  }),
  Schema.Struct({ status: Schema.Literal("not-found") }),
  Schema.Struct({ status: Schema.Literal("unreadable") }),
]);
export type LegacyImportPreferencesPreview = typeof LegacyImportPreferencesPreview.Type;

const LegacyImportAvailablePreview = Schema.Struct({
  status: Schema.Literal("available"),
  sourceKind: LegacyImportSourceKind,
  projects: Schema.Array(LegacyImportProjectPreview),
  schemaVersion: Schema.NullOr(PositiveInt),
  preferences: Schema.optional(LegacyImportPreferencesPreview),
});

const LegacyImportUnavailablePreview = Schema.Struct({
  status: Schema.Literal("unavailable"),
  reason: LegacyImportUnavailableReason,
});

/** Read-only summary of the default T3 home on the connected server. */
export const LegacyImportPreview = Schema.Union([
  LegacyImportNotFoundPreview,
  LegacyImportAvailablePreview,
  LegacyImportUnavailablePreview,
]);
export type LegacyImportPreview = typeof LegacyImportPreview.Type;

export const LegacyImportRequest = Schema.Struct({
  projectIds: Schema.Array(Schema.String),
  includeSettings: Schema.Boolean,
});
export type LegacyImportRequest = typeof LegacyImportRequest.Type;

export const LegacyImportProjectStatus = Schema.Literals([
  "imported",
  "merged",
  "skipped",
  "failed",
]);
export type LegacyImportProjectStatus = typeof LegacyImportProjectStatus.Type;

export const LegacyImportProjectResult = Schema.Struct({
  sourceProjectId: Schema.String,
  targetProjectId: Schema.String,
  title: Schema.String,
  status: LegacyImportProjectStatus,
  threadCount: NonNegativeInt,
  repairedThreadCount: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  skippedAttachmentCount: NonNegativeInt,
  detail: Schema.optional(Schema.String),
});
export type LegacyImportProjectResult = typeof LegacyImportProjectResult.Type;

export const LegacyImportSettingsStatus = Schema.Literals(["imported", "not-found", "failed"]);
export type LegacyImportSettingsStatus = typeof LegacyImportSettingsStatus.Type;

export const LegacyImportSettingsResult = Schema.Struct({
  status: LegacyImportSettingsStatus,
  detail: Schema.optional(Schema.String),
});
export type LegacyImportSettingsResult = typeof LegacyImportSettingsResult.Type;

export const LegacyImportResult = Schema.Struct({
  sourceKind: LegacyImportSourceKind,
  projects: Schema.Array(LegacyImportProjectResult),
  settings: Schema.optional(LegacyImportSettingsResult),
  importedProjectCount: NonNegativeInt,
  importedThreadCount: NonNegativeInt,
  repairedThreadCount: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  skippedAttachmentCount: NonNegativeInt,
});
export type LegacyImportResult = typeof LegacyImportResult.Type;

export const LegacyImportFailureReason = Schema.Literals([
  "source-not-found",
  "source-changed",
  "unsupported-source",
  "read-failed",
]);
export type LegacyImportFailureReason = typeof LegacyImportFailureReason.Type;

export class LegacyImportError extends Schema.TaggedErrorClass<LegacyImportError>()(
  "LegacyImportError",
  {
    reason: LegacyImportFailureReason,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}
