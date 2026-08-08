import { useAtomValue } from "@effect/atom-react";
import {
  canonicalComposerDraftCommon,
  composerDraftCommonEquals,
  createComposerDraftEnvironmentAtoms,
  createComposerDraftSyncController,
  type ComposerDraftSyncController,
} from "@t3tools/client-runtime/state/composer-drafts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type {
  ComposerDraftCommon,
  ComposerDraftSnapshot,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useEffect, useRef } from "react";

import {
  type ComposerThreadDraftState,
  DraftId,
  useComposerThreadDraft,
  useComposerDraftStore,
} from "../composerDraftStore";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { serverEnvironment } from "./server";
import { randomUUID } from "../lib/utils";

export const composerDraftEnvironment = createComposerDraftEnvironmentAtoms(connectionAtomRuntime);

const EMPTY_SYNC_ATOM = Atom.make<null>(null).pipe(Atom.withLabel("composer-draft-sync:disabled"));
const revisions = new Map<string, number>();
const suppressedPostSendCommon = new Map<string, ComposerDraftCommon | null>();

export function readComposerDraftRevision(threadRef: ScopedThreadRef): number | undefined {
  return revisions.get(scopedThreadKey(threadRef));
}

function commonFromDraft(draft: ComposerThreadDraftState): ComposerDraftCommon | null {
  const hasLocalOnlyContext =
    draft.images.length > 0 ||
    draft.persistedAttachments.length > 0 ||
    draft.terminalContexts.length > 0 ||
    draft.elementContexts.length > 0 ||
    draft.issueContexts.length > 0 ||
    draft.previewAnnotations.length > 0 ||
    draft.reviewComments.length > 0;
  if (hasLocalOnlyContext) return null;
  return canonicalComposerDraftCommon({
    text: draft.prompt,
    modelSelection:
      draft.activeProvider === null
        ? null
        : (draft.modelSelectionByProvider[draft.activeProvider] ?? null),
    runtimeMode: draft.runtimeMode,
    interactionMode: draft.interactionMode,
  });
}

/** Prevents retained model/mode preferences from resurrecting a sent draft. */
export function markComposerDraftSent(threadRef: ScopedThreadRef): void {
  const key = scopedThreadKey(threadRef);
  const draft = useComposerDraftStore.getState().getComposerDraft(threadRef);
  suppressedPostSendCommon.set(key, draft === null ? null : commonFromDraft(draft));
}

function mutationId(): string {
  return `web:${randomUUID()}`;
}

export function useServerComposerDraftSync(threadRef: ScopedThreadRef | null): void {
  const serverConfig = useAtomValue(
    threadRef === null
      ? EMPTY_SYNC_ATOM
      : serverEnvironment.configValueAtom(threadRef.environmentId),
  );
  const enabled =
    threadRef !== null &&
    serverConfig !== null &&
    "environment" in serverConfig &&
    serverConfig.environment.capabilities.composerDraftSync === true;
  const streamResult = useAtomValue(
    enabled && threadRef !== null
      ? composerDraftEnvironment.changes({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        })
      : EMPTY_SYNC_ATOM,
  );
  const draft = useComposerThreadDraft(
    threadRef ?? DraftId.make("__composer-draft-sync-disabled__"),
  );
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const controllerRef = useRef<ComposerDraftSyncController | null>(null);

  useEffect(() => {
    controllerRef.current?.dispose();
    if (!enabled || threadRef === null) {
      controllerRef.current = null;
      return;
    }
    const key = scopedThreadKey(threadRef);
    const readLocal = (): ComposerDraftCommon | null => {
      const common = commonFromDraft(draftRef.current);
      if (!suppressedPostSendCommon.has(key)) return common;
      const baseline = suppressedPostSendCommon.get(key) ?? null;
      if (composerDraftCommonEquals(common, baseline)) return null;
      suppressedPostSendCommon.delete(key);
      return common;
    };
    const controller = createComposerDraftSyncController({
      threadId: threadRef.threadId,
      readLocal,
      canApplyRemote: () => {
        const current = draftRef.current;
        return (
          current.images.length === 0 &&
          current.persistedAttachments.length === 0 &&
          current.terminalContexts.length === 0 &&
          current.elementContexts.length === 0 &&
          current.issueContexts.length === 0 &&
          current.previewAnnotations.length === 0 &&
          current.reviewComments.length === 0
        );
      },
      applyRemote: (common) =>
        useComposerDraftStore.getState().applySyncedCommon(threadRef, common),
      update: async (input) => {
        const result = await composerDraftEnvironment.update.run(appAtomRegistry, {
          environmentId: threadRef.environmentId,
          input,
        });
        return AsyncResult.isSuccess(result) ? result.value : null;
      },
      createMutationId: mutationId,
      scheduleTask: (task, delayMs) => {
        const timer = window.setTimeout(task, delayMs);
        return () => window.clearTimeout(timer);
      },
      onRevisionChange: (snapshot: ComposerDraftSnapshot) => {
        revisions.set(key, snapshot.revision);
      },
    });
    controllerRef.current = controller;
    return () => {
      controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
      revisions.delete(key);
      suppressedPostSendCommon.delete(key);
    };
  }, [enabled, threadRef?.environmentId, threadRef?.threadId]);

  useEffect(() => {
    if (streamResult !== null && AsyncResult.isSuccess(streamResult)) {
      controllerRef.current?.observeSnapshot(streamResult.value);
    }
  }, [streamResult]);

  useEffect(() => {
    controllerRef.current?.observeLocalChange();
  }, [
    draft.activeProvider,
    draft.elementContexts,
    draft.images,
    draft.interactionMode,
    draft.issueContexts,
    draft.modelSelectionByProvider,
    draft.persistedAttachments,
    draft.previewAnnotations,
    draft.prompt,
    draft.reviewComments,
    draft.runtimeMode,
    draft.terminalContexts,
  ]);
}
