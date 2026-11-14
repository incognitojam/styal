import {
  type WorktreeCleanupPreview,
  type WorktreeCleanupPreviewEntry,
  WS_METHODS,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { createAtomCommandScheduler, createEnvironmentRpcCommand } from "./runtime.ts";

/** Preview, approval and revocation of a project's `worktreeCleanup` patterns. */
export function createWorktreeCleanupAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const serial = {
    scheduler: createAtomCommandScheduler(),
    concurrency: {
      mode: "serial" as const,
      key: ({ environmentId }: { environmentId: string }) => environmentId,
    },
  };
  return {
    preview: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:worktree-cleanup:preview",
      tag: WS_METHODS.projectsWorktreeCleanupPreview,
    }),
    /** Approves the given patterns that styal.json declares now; user clients only. */
    approve: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:worktree-cleanup:approve",
      tag: WS_METHODS.projectsWorktreeCleanupApprove,
      ...serial,
    }),
    /** Revokes one pattern, or every pattern of the project when `pattern` is null. */
    revoke: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:worktree-cleanup:revoke",
      tag: WS_METHODS.projectsWorktreeCleanupRevoke,
      ...serial,
    }),
  };
}

export interface WorktreeCleanupPatternList {
  /** Declared and not approved on this machine, in styal.json order. */
  readonly pending: readonly string[];
  /** Declared and approved, in styal.json order. */
  readonly approved: readonly string[];
  /** Approved earlier and no longer declared, newest approval first. */
  readonly earlier: readonly { readonly pattern: string; readonly approvedAt: string }[];
}

/**
 * Splits the declared patterns by this machine's approvals. Patterns are
 * compared trimmed, so order, duplicates and surrounding spaces in styal.json
 * never change what is approved.
 */
export function worktreeCleanupPatternList(
  declared: readonly string[] | undefined,
  approvals: Readonly<Record<string, { readonly approvedAt: string }>> | undefined,
): WorktreeCleanupPatternList {
  const seen = new Set<string>();
  const pending: string[] = [];
  const approved: string[] = [];
  for (const raw of declared ?? []) {
    const pattern = raw.trim();
    if (pattern.length === 0 || seen.has(pattern)) continue;
    seen.add(pattern);
    (approvals?.[pattern] ? approved : pending).push(pattern);
  }
  const earlier = Object.entries(approvals ?? {})
    .filter(([pattern]) => !seen.has(pattern))
    .map(([pattern, { approvedAt }]) => ({ pattern, approvedAt }))
    .sort((left, right) => right.approvedAt.localeCompare(left.approvedAt));
  return { pending, approved, earlier };
}

/** A guess from the pattern alone, used until a preview shows what it matches. */
export function worktreeCleanupPatternShape(pattern: string): "file" | "directory" {
  const last = pattern.slice(pattern.lastIndexOf("/") + 1);
  return last.startsWith("*.") ? "file" : "directory";
}

export interface WorktreeCleanupPatternMatches {
  readonly kind: "file" | "directory" | "mixed";
  readonly count: number;
  readonly worktrees: number;
  readonly bytes: number;
}

/** What each pattern matches now in worktrees that could be cleaned. */
export function worktreeCleanupMatchesByPattern(
  preview: WorktreeCleanupPreview,
): ReadonlyMap<string, WorktreeCleanupPatternMatches> {
  const totals = new Map<
    string,
    { kinds: Set<string>; count: number; worktrees: Set<string>; bytes: number }
  >();
  for (const entry of preview.worktrees) {
    if (entry.status !== "eligible") continue;
    for (const selected of entry.selected) {
      const total = totals.get(selected.pattern) ?? {
        kinds: new Set<string>(),
        count: 0,
        worktrees: new Set<string>(),
        bytes: 0,
      };
      total.kinds.add(selected.kind);
      total.count += 1;
      total.worktrees.add(entry.worktreePath);
      total.bytes += selected.freedBytes ?? 0;
      totals.set(selected.pattern, total);
    }
  }
  return new Map(
    [...totals].map(([pattern, total]) => [
      pattern,
      {
        kind:
          total.kinds.size > 1
            ? "mixed"
            : total.kinds.has("file")
              ? "file"
              : ("directory" as const),
        count: total.count,
        worktrees: total.worktrees.size,
        bytes: total.bytes,
      },
    ]),
  );
}

export type WorktreeCleanupNotCleanedReason =
  | "frees-nothing"
  | "nothing-matched"
  | "not-settled"
  | "missing"
  | "symbolic-link"
  | "not-managed";

export interface WorktreeCleanupResultRow {
  readonly entry: WorktreeCleanupPreviewEntry;
  /** Bytes the approved patterns would free; 0 when nothing would be freed. */
  readonly freedBytes: number;
  readonly reason: WorktreeCleanupNotCleanedReason | null;
}

/**
 * Worktrees the approved patterns would free space in, largest first, and
 * the rest with the reason each is not cleaned. `approved` is the current
 * approved set, so approving after a preview updates the totals.
 */
export function worktreeCleanupResults(
  preview: WorktreeCleanupPreview,
  approvedPatterns: ReadonlySet<string>,
): {
  readonly cleaned: readonly WorktreeCleanupResultRow[];
  readonly notCleaned: readonly WorktreeCleanupResultRow[];
  readonly totalBytes: number;
} {
  const rows = preview.worktrees.map((entry): WorktreeCleanupResultRow => {
    const approved = entry.selected.filter((selected) => approvedPatterns.has(selected.pattern));
    const freedBytes = approved.reduce((sum, selected) => sum + (selected.freedBytes ?? 0), 0);
    if (entry.status === "kept") {
      const reason =
        entry.reason === "unsettled-thread"
          ? "not-settled"
          : entry.reason === "missing"
            ? "missing"
            : entry.reason === "symbolic-link"
              ? "symbolic-link"
              : "not-managed";
      return { entry, freedBytes: 0, reason };
    }
    if (approved.length === 0) return { entry, freedBytes: 0, reason: "nothing-matched" };
    return { entry, freedBytes, reason: freedBytes > 0 ? null : "frees-nothing" };
  });
  const cleaned = rows
    .filter((row) => row.reason === null)
    .sort((left, right) => right.freedBytes - left.freedBytes);
  return {
    cleaned,
    notCleaned: rows.filter((row) => row.reason !== null),
    totalBytes: cleaned.reduce((sum, row) => sum + row.freedBytes, 0),
  };
}
