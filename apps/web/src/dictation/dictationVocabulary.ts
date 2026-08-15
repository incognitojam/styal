// Vocabulary scoping for the dictation matcher.
//
// The spike measured this as the highest-leverage decision in the feature:
// ~100 context-scoped terms performed well, while a repo-wide extract damaged
// more than a third of utterances ("and then" -> andThen, "is fast" -> isLast;
// finding 12). This module is the seam for that scoping. The v1 source is
// deliberately narrow: identifiers already visible in the composer draft and
// stash — text the user is actively working with. Symbol extraction from
// composer file mentions and the active thread is tracked as follow-up work.

import { useComposerDraftStore } from "../composerDraftStore";
import { usePromptStashStore } from "../promptStashStore";

export const DICTATION_VOCABULARY_LIMIT = 100;

const IDENTIFIER_PATTERN =
  /\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b|\b[A-Z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b|\b[a-z][a-z0-9]*_[a-z][a-z0-9_]*\b/g;

export function extractIdentifiers(text: string): string[] {
  return text.match(IDENTIFIER_PATTERN) ?? [];
}

/**
 * Most-frequent-first, capped. Order matters twice over: the matcher collapses
 * spoken-form collisions keeping the first occurrence, and the cap should drop
 * the rarest terms.
 */
export function rankIdentifiers(identifiers: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const identifier of identifiers) {
    counts.set(identifier, (counts.get(identifier) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, DICTATION_VOCABULARY_LIMIT)
    .map(([identifier]) => identifier);
}

/** Snapshot of identifiers in the user's working text, for one utterance. */
export function collectDictationVocabulary(): string[] {
  const sources: string[] = [];
  const drafts = useComposerDraftStore.getState().draftsByThreadKey;
  for (const draft of Object.values(drafts)) {
    if (typeof draft?.prompt === "string") {
      sources.push(draft.prompt);
    }
  }
  for (const entry of usePromptStashStore.getState().entries) {
    sources.push(entry.prompt);
  }
  return rankIdentifiers(sources.flatMap(extractIdentifiers));
}
