import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection, ProviderInteractionMode, RuntimeMode } from "./orchestration.ts";

/**
 * The cross-surface portion of an existing thread's composer draft.
 *
 * Attachments and surface-specific context intentionally stay out of v1. The
 * server replaces this section as one revisioned value so clients never erase
 * fields owned by a surface they do not understand.
 */
export const ComposerDraftCommon = Schema.Struct({
  text: Schema.String,
  modelSelection: Schema.NullOr(ModelSelection),
  runtimeMode: Schema.NullOr(RuntimeMode),
  interactionMode: Schema.NullOr(ProviderInteractionMode),
});
export type ComposerDraftCommon = typeof ComposerDraftCommon.Type;

/** A null common section is a durable tombstone, not an unknown draft. */
export const ComposerDraftSnapshot = Schema.Struct({
  threadId: ThreadId,
  revision: NonNegativeInt,
  common: Schema.NullOr(ComposerDraftCommon),
  updatedAt: Schema.NullOr(IsoDateTime),
  clientMutationId: Schema.NullOr(TrimmedNonEmptyString),
});
export type ComposerDraftSnapshot = typeof ComposerDraftSnapshot.Type;

export const ComposerDraftGetInput = Schema.Struct({ threadId: ThreadId });
export type ComposerDraftGetInput = typeof ComposerDraftGetInput.Type;

export const ComposerDraftUpdateInput = Schema.Struct({
  threadId: ThreadId,
  baseRevision: NonNegativeInt,
  common: Schema.NullOr(ComposerDraftCommon),
  clientMutationId: TrimmedNonEmptyString,
});
export type ComposerDraftUpdateInput = typeof ComposerDraftUpdateInput.Type;

export const ComposerDraftUpdateResult = Schema.Union([
  Schema.TaggedStruct("accepted", { snapshot: ComposerDraftSnapshot }),
  Schema.TaggedStruct("conflict", { snapshot: ComposerDraftSnapshot }),
]);
export type ComposerDraftUpdateResult = typeof ComposerDraftUpdateResult.Type;

export class ComposerDraftSyncError extends Schema.TaggedErrorClass<ComposerDraftSyncError>()(
  "ComposerDraftSyncError",
  { message: Schema.String },
) {}
