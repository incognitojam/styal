/**
 * What is already known about a reference, shared across the bodies of one panel so each comment
 * does not re-ask what its neighbour just resolved. A resolved reference expires sooner than a
 * missing one. A plain map with the clock passed in, since a batch is filled and read as a batch.
 */
import type { SourceControlReference, SourceControlResolvedReference } from "@t3tools/contracts";

export interface ReferenceCacheOptions {
  readonly resolvedTtlMs?: number;
  readonly missingTtlMs?: number;
  readonly capacity?: number;
}

export interface ReferenceCache {
  /** Splits a batch into what is already known and what still has to be asked. */
  readonly read: (
    now: number,
    host: string,
    references: ReadonlyArray<SourceControlReference>,
  ) => {
    readonly cached: ReadonlyArray<SourceControlResolvedReference>;
    readonly unanswered: ReadonlyArray<SourceControlReference>;
  };
  readonly write: (
    now: number,
    host: string,
    resolved: ReadonlyArray<SourceControlResolvedReference>,
  ) => void;
  readonly size: () => number;
}

const RESOLVED_TTL_MS = 5 * 60_000;
const MISSING_TTL_MS = 10 * 60_000;
const CAPACITY = 2048;

/** The host is part of the key: an Enterprise install and github.com spell numbers alike. */
function cacheKey(host: string, reference: SourceControlReference): string {
  return `${host.toLowerCase()} ${reference.repository.toLowerCase()}#${reference.number}`;
}

export function makeReferenceCache(options: ReferenceCacheOptions = {}): ReferenceCache {
  const resolvedTtlMs = options.resolvedTtlMs ?? RESOLVED_TTL_MS;
  const missingTtlMs = options.missingTtlMs ?? MISSING_TTL_MS;
  const capacity = options.capacity ?? CAPACITY;
  const entries = new Map<
    string,
    { readonly reference: SourceControlResolvedReference; readonly expiresAt: number }
  >();

  return {
    read: (now, host, references) => {
      const cached: Array<SourceControlResolvedReference> = [];
      const unanswered: Array<SourceControlReference> = [];
      for (const reference of references) {
        const entry = entries.get(cacheKey(host, reference));
        if (entry && entry.expiresAt > now) cached.push(entry.reference);
        else unanswered.push(reference);
      }
      return { cached, unanswered };
    },
    write: (now, host, resolved) => {
      for (const reference of resolved) {
        if (entries.size >= capacity) {
          // Insertion order is age order here, so the oldest entry is the first key.
          const oldest = entries.keys().next();
          if (!oldest.done) entries.delete(oldest.value);
        }
        entries.set(cacheKey(host, reference), {
          reference,
          expiresAt: now + (reference.kind === null ? missingTtlMs : resolvedTtlMs),
        });
      }
    },
    size: () => entries.size,
  };
}
