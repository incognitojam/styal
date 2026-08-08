import { useAtomValue } from "@effect/atom-react";
import {
  canonicalComposerDraftCommon,
  composerDraftCommonEquals,
  createComposerDraftEnvironmentAtoms,
  createComposerDraftSyncController,
  type ComposerDraftSyncController,
} from "@t3tools/client-runtime/state/composer-drafts";
import type {
  ComposerDraftCommon,
  ComposerDraftSnapshot,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useEffect, useRef } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { scopedThreadKey } from "../lib/scopedEntities";
import { uuidv4 } from "../lib/uuid";
import { appAtomRegistry } from "./atom-registry";
import { serverEnvironment } from "./server";
import {
  applySyncedComposerDraftCommon,
  composerDraftsAtom,
  composerDraftsLoadedAtom,
  type ComposerDraft,
} from "./use-composer-drafts";

export const composerDraftEnvironment = createComposerDraftEnvironmentAtoms(connectionAtomRuntime);

const EMPTY_SYNC_ATOM = Atom.make<null>(null).pipe(
  Atom.withLabel("mobile:composer-draft-sync-disabled"),
);
const revisions = new Map<string, number>();
const suppressedPostSendCommon = new Map<string, ComposerDraftCommon | null>();

export function readComposerDraftRevision(threadRef: ScopedThreadRef): number | undefined {
  return revisions.get(scopedThreadKey(threadRef.environmentId, threadRef.threadId));
}

/** Prevents retained selector settings from being mistaken for a new draft. */
export function markComposerDraftSent(threadRef: ScopedThreadRef): void {
  const key = scopedThreadKey(threadRef.environmentId, threadRef.threadId);
  const draft = appAtomRegistry.get(composerDraftsAtom)[key];
  suppressedPostSendCommon.set(key, commonFromDraft(draft ?? { text: "", attachments: [] }));
}

function commonFromDraft(draft: ComposerDraft): ComposerDraftCommon | null {
  if (draft.attachments.length > 0) return null;
  return canonicalComposerDraftCommon({
    text: draft.text,
    modelSelection: draft.modelSelection ?? null,
    runtimeMode: draft.runtimeMode ?? null,
    interactionMode: draft.interactionMode ?? null,
  });
}

export function useServerComposerDraftSync(threadRef: ScopedThreadRef | null): void {
  const drafts = useAtomValue(composerDraftsAtom);
  const draftsLoaded = useAtomValue(composerDraftsLoadedAtom);
  const serverConfig = useAtomValue(
    threadRef === null
      ? EMPTY_SYNC_ATOM
      : serverEnvironment.configValueAtom(threadRef.environmentId),
  );
  const enabled =
    draftsLoaded &&
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
  const draftKey =
    threadRef === null ? null : scopedThreadKey(threadRef.environmentId, threadRef.threadId);
  const draft = draftKey === null ? null : (drafts[draftKey] ?? null);
  const draftRef = useRef<ComposerDraft | null>(draft);
  draftRef.current = draft;
  const controllerRef = useRef<ComposerDraftSyncController | null>(null);

  useEffect(() => {
    controllerRef.current?.dispose();
    if (!enabled || threadRef === null || draftKey === null) {
      controllerRef.current = null;
      return;
    }
    const key = draftKey;
    const readLocal = () => {
      const common = commonFromDraft(draftRef.current ?? { text: "", attachments: [] });
      if (!suppressedPostSendCommon.has(key)) return common;
      const baseline = suppressedPostSendCommon.get(key) ?? null;
      if (composerDraftCommonEquals(common, baseline)) return null;
      suppressedPostSendCommon.delete(key);
      return common;
    };
    const controller = createComposerDraftSyncController({
      threadId: threadRef.threadId,
      readLocal,
      canApplyRemote: () => (draftRef.current?.attachments.length ?? 0) === 0,
      applyRemote: (common) => applySyncedComposerDraftCommon(key, common),
      update: async (input) => {
        const result = await composerDraftEnvironment.update.run(appAtomRegistry, {
          environmentId: threadRef.environmentId,
          input,
        });
        return AsyncResult.isSuccess(result) ? result.value : null;
      },
      createMutationId: () => `mobile:${uuidv4()}`,
      scheduleTask: (task, delayMs) => {
        const timer = setTimeout(task, delayMs);
        return () => clearTimeout(timer);
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
  }, [draftKey, enabled, threadRef?.environmentId, threadRef?.threadId]);

  useEffect(() => {
    if (streamResult !== null && AsyncResult.isSuccess(streamResult)) {
      controllerRef.current?.observeSnapshot(streamResult.value);
    }
  }, [streamResult]);

  useEffect(() => {
    controllerRef.current?.observeLocalChange();
  }, [
    draft?.attachments,
    draft?.interactionMode,
    draft?.modelSelection,
    draft?.runtimeMode,
    draft?.text,
  ]);
}
