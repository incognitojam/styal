import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "./atom-registry";

/**
 * A picked or shared attachment the composer is still turning into draft content. It is
 * shown in the strip straight away and blocks sending until it lands in the draft.
 */
export interface PendingComposerAttachment {
  readonly id: string;
  /** The source the user picked, when it can be drawn while it is processed. */
  readonly previewUri: string | null;
}

const EMPTY: ReadonlyArray<PendingComposerAttachment> = [];

const pendingComposerAttachmentsAtom = Atom.make<
  Readonly<Record<string, ReadonlyArray<PendingComposerAttachment>>>
>({}).pipe(Atom.keepAlive);
const pendingForDraftAtom = Atom.family((draftKey: string) =>
  Atom.map(pendingComposerAttachmentsAtom, (pending) => pending[draftKey] ?? EMPTY),
);

export function usePendingComposerAttachments(
  draftKey: string | null | undefined,
): ReadonlyArray<PendingComposerAttachment> {
  return useAtomValue(pendingForDraftAtom(draftKey ?? ""));
}

export function readPendingComposerAttachments(
  draftKey: string,
): ReadonlyArray<PendingComposerAttachment> {
  return appAtomRegistry.get(pendingForDraftAtom(draftKey));
}

function update(
  draftKey: string,
  change: (current: ReadonlyArray<PendingComposerAttachment>) => PendingComposerAttachment[],
): void {
  const all = appAtomRegistry.get(pendingComposerAttachmentsAtom);
  const nextForDraft = change(all[draftKey] ?? EMPTY);
  const next = { ...all };
  if (nextForDraft.length > 0) next[draftKey] = nextForDraft;
  else delete next[draftKey];
  appAtomRegistry.set(pendingComposerAttachmentsAtom, next);
}

export function addPendingComposerAttachments(
  draftKey: string,
  attachments: ReadonlyArray<PendingComposerAttachment>,
): void {
  if (attachments.length === 0) return;
  update(draftKey, (current) => [...current, ...attachments]);
}

export function removePendingComposerAttachments(
  draftKey: string,
  attachments: ReadonlyArray<PendingComposerAttachment>,
): void {
  if (attachments.length === 0) return;
  const ids = new Set(attachments.map((attachment) => attachment.id));
  update(draftKey, (current) => current.filter((attachment) => !ids.has(attachment.id)));
}

/**
 * Shows what `pick` reports through `onPicked` until its result has landed, so the strip
 * goes from placeholder to attachment without an empty frame in between. Outside components
 * because React Compiler cannot compile try/finally.
 */
export async function withPendingComposerAttachments<T>(
  draftKey: string,
  pick: (onPicked: (pending: ReadonlyArray<PendingComposerAttachment>) => void) => Promise<T>,
  land: (result: T) => void,
): Promise<void> {
  let pending: ReadonlyArray<PendingComposerAttachment> = EMPTY;
  try {
    land(
      await pick((picked) => {
        pending = picked;
        addPendingComposerAttachments(draftKey, picked);
      }),
    );
  } finally {
    removePendingComposerAttachments(draftKey, pending);
  }
}
