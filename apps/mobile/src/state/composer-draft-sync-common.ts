import { canonicalComposerDraftCommon } from "@t3tools/client-runtime/state/composer-drafts";
import type { ComposerDraftCommon } from "@t3tools/contracts";

import type { ComposerDraft } from "./use-composer-drafts";

type SyncedDraftFields = Pick<
  ComposerDraft,
  "text" | "context" | "attachments" | "modelSelection" | "runtimeMode" | "interactionMode"
>;

/**
 * Attachments and context records (terminal output, review comments, pull requests, pasted
 * context) stay on this device. Their chips are links in the text, so syncing the text alone
 * would give other devices links whose records never arrive.
 */
export function hasLocalOnlyComposerDraftContent(draft: SyncedDraftFields): boolean {
  return draft.attachments.length > 0 || (draft.context?.records.length ?? 0) > 0;
}

/** The section of a thread draft shared with other devices, or null to keep it on this one. */
export function composerDraftSyncCommon(draft: SyncedDraftFields): ComposerDraftCommon | null {
  if (hasLocalOnlyComposerDraftContent(draft)) return null;
  return canonicalComposerDraftCommon({
    text: draft.text,
    modelSelection: draft.modelSelection ?? null,
    runtimeMode: draft.runtimeMode ?? null,
    interactionMode: draft.interactionMode ?? null,
  });
}
