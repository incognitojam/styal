import { Atom } from "effect/unstable/reactivity";

import { scopedThreadKey } from "../lib/scopedEntities";
import { appAtomRegistry } from "./atom-registry";
import type { PendingThreadCreationOutcome } from "./pending-thread-creation";

export const pendingThreadCreationOutcomesAtom = Atom.make<
  Readonly<Record<string, PendingThreadCreationOutcome>>
>({}).pipe(Atom.keepAlive, Atom.withLabel("mobile:pending-thread-creation:outcomes"));

export function recordPendingThreadCreationOutcome(outcome: PendingThreadCreationOutcome): void {
  const key = scopedThreadKey(outcome.message.environmentId, outcome.message.threadId);
  appAtomRegistry.set(pendingThreadCreationOutcomesAtom, {
    ...appAtomRegistry.get(pendingThreadCreationOutcomesAtom),
    [key]: outcome,
  });
}

export function clearPendingThreadCreationOutcome(threadKey: string): void {
  const current = appAtomRegistry.get(pendingThreadCreationOutcomesAtom);
  if (!current[threadKey]) return;
  const next = { ...current };
  delete next[threadKey];
  appAtomRegistry.set(pendingThreadCreationOutcomesAtom, next);
}
