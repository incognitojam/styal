import {
  type WorktreeCleanupPreview,
  type WorktreeCleanupPreviewEntry,
  type WorktreeCleanupPreviewInput,
  type ProjectId,
  type ServerSettings,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { matchesWorktreeCleanupPattern } from "@t3tools/shared/worktreeCleanupPatterns";
import { Atom } from "effect/reactivity";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { requestGuarded } from "../rpc/client.ts";
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
    /**
     * Aborting `signal` interrupts the request, which stops the walk on the
     * server; a preview reads many files, so a page that goes away cancels it.
     */
    preview: createEnvironmentRpcCommand<
      EnvironmentRegistry | R,
      E,
      typeof WS_METHODS.projectsWorktreeCleanupPreview,
      WorktreeCleanupPreviewInput & { readonly signal?: AbortSignal }
    >(runtime, {
      label: "environment-data:worktree-cleanup:preview",
      tag: WS_METHODS.projectsWorktreeCleanupPreview,
      execute: ({ signal, ...input }) => {
        const request = requestGuarded(WS_METHODS.projectsWorktreeCleanupPreview, input);
        if (signal === undefined) return request;
        return Effect.raceFirst(
          request,
          Effect.callback<never>((resume) => {
            const abort = () => resume(Effect.interrupt);
            if (signal.aborted) abort();
            else signal.addEventListener("abort", abort, { once: true });
            return Effect.sync(() => signal.removeEventListener("abort", abort));
          }),
        );
      },
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

/**
 * This machine's approvals for one project. They are keyed by the project's
 * id, never by its repository, so two checkouts of one repository stay apart.
 */
export function worktreeCleanupApprovalsFor(
  settings: { readonly worktreeCleanupApprovals: ServerSettings["worktreeCleanupApprovals"] },
  project: { readonly id: ProjectId },
): Readonly<Record<string, { readonly approvedAt: string }>> | undefined {
  return Object.hasOwn(settings.worktreeCleanupApprovals, project.id)
    ? settings.worktreeCleanupApprovals[project.id]
    : undefined;
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
    (approvals !== undefined && Object.hasOwn(approvals, pattern) ? approved : pending).push(
      pattern,
    );
  }
  const earlier = Object.entries(approvals ?? {})
    .filter(([pattern]) => !seen.has(pattern))
    .map(([pattern, { approvedAt }]) => ({ pattern, approvedAt }))
    .sort((left, right) => right.approvedAt.localeCompare(left.approvedAt));
  return { pending, approved, earlier };
}

/** Root folders that often hold notes or work in progress rather than build output. */
const WORK_FOLDERS = [".scratch", ".plans"] as const;

/**
 * The work folders a pattern can delete from or inside, from the pattern
 * itself and from paths a preview found.
 */
export function worktreeCleanupWorkFolders(
  pattern: string,
  matchedPaths: readonly string[] = [],
): readonly string[] {
  return WORK_FOLDERS.filter(
    (folder) =>
      matchesWorktreeCleanupPattern(pattern, folder) ||
      pattern.startsWith(`${folder}/`) ||
      matchedPaths.some((path) => path === folder || path.startsWith(`${folder}/`)),
  );
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
  /** Bytes measured; a lower bound when `incomplete`. */
  readonly bytes: number;
  /** Some matches were not measured or not listed, so `count` and `bytes` are lower bounds. */
  readonly incomplete: boolean;
}

/**
 * What each pattern matches now in worktrees that could be cleaned. A path
 * matched by several patterns counts towards each of them.
 */
/**
 * Whether the preview looked at everything: every worktree reached, every
 * walk finished and every candidate measured. When it did not, a pattern
 * with no matches may still match something.
 */
export function worktreeCleanupPreviewComplete(preview: WorktreeCleanupPreview): boolean {
  return (
    !preview.worktreesTruncated &&
    !preview.deadlineReached &&
    preview.worktrees.every(
      (entry) =>
        (entry.status !== "eligible" && entry.reason !== "not-checked") ||
        (!entry.entriesTruncated &&
          entry.measurementComplete &&
          !entry.kept.some((kept) => kept.reason === "too-large-to-verify")),
    )
  );
}

export function worktreeCleanupMatchesByPattern(
  preview: WorktreeCleanupPreview,
): ReadonlyMap<string, WorktreeCleanupPatternMatches> {
  const complete = worktreeCleanupPreviewComplete(preview);
  const totals = new Map<
    string,
    {
      kinds: Set<string>;
      count: number;
      worktrees: Set<string>;
      bytes: number;
      incomplete: boolean;
    }
  >();
  for (const entry of preview.worktrees) {
    if (entry.status !== "eligible") continue;
    for (const selected of entry.selected) {
      const ancestors = selectedAncestors(entry, selected);
      for (const pattern of selected.patterns) {
        // A path inside another match of the same pattern is already in that match's bytes.
        if (ancestors.some((ancestor) => ancestor.patterns.includes(pattern))) continue;
        const total = totals.get(pattern) ?? {
          kinds: new Set<string>(),
          count: 0,
          worktrees: new Set<string>(),
          bytes: 0,
          incomplete: false,
        };
        total.kinds.add(selected.kind);
        total.count += 1;
        total.worktrees.add(entry.worktreePath);
        total.bytes += selected.freedBytes ?? 0;
        if (selected.freedBytes === null || entry.entriesTruncated) total.incomplete = true;
        totals.set(pattern, total);
      }
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
        incomplete: total.incomplete || !complete,
      },
    ]),
  );
}

/** Every path a preview found for each pattern, selected or kept. */
export function worktreeCleanupPathsByPattern(
  preview: WorktreeCleanupPreview,
): ReadonlyMap<string, readonly string[]> {
  const paths = new Map<string, string[]>();
  const add = (pattern: string, path: string) => {
    const list = paths.get(pattern) ?? [];
    list.push(path);
    paths.set(pattern, list);
  };
  for (const entry of preview.worktrees) {
    for (const selected of entry.selected) {
      for (const pattern of selected.patterns) add(pattern, selected.path);
    }
    for (const kept of entry.kept) add(kept.pattern, kept.path);
  }
  return paths;
}

export type WorktreeCleanupNotCleanedReason =
  | "frees-nothing"
  | "nothing-matched"
  | "not-fully-checked"
  | "too-large"
  | "not-settled"
  | "missing"
  | "symbolic-link"
  | "not-managed";

export interface WorktreeCleanupResultRow {
  readonly entry: WorktreeCleanupPreviewEntry;
  /** Bytes the approved patterns would free; a lower bound when `incomplete`. */
  readonly freedBytes: number;
  /** Some selected paths were not measured or not listed. */
  readonly incomplete: boolean;
  readonly reason: WorktreeCleanupNotCleanedReason | null;
}

/**
 * Worktrees the approved patterns would free space in, largest first, and
 * the rest with the reason each is not cleaned. A path counts when any
 * pattern that matches it is approved. `approvedPatterns` is the current
 * approved set, so approving after a preview updates the totals.
 */
export function worktreeCleanupResults(
  preview: WorktreeCleanupPreview,
  approvedPatterns: ReadonlySet<string>,
): {
  readonly cleaned: readonly WorktreeCleanupResultRow[];
  readonly notCleaned: readonly WorktreeCleanupResultRow[];
  readonly totalBytes: number;
  readonly incomplete: boolean;
} {
  const rows = preview.worktrees.map((entry): WorktreeCleanupResultRow => {
    const approved = worktreeCleanupApprovedSelection(entry, approvedPatterns);
    const freedBytes = approved.reduce((sum, selected) => sum + (selected.freedBytes ?? 0), 0);
    const tooLarge = entry.kept.some(
      (kept) => kept.reason === "too-large-to-verify" && approvedPatterns.has(kept.pattern),
    );
    const incomplete =
      entry.entriesTruncated ||
      !entry.measurementComplete ||
      tooLarge ||
      approved.some((selected) => selected.freedBytes === null);
    if (entry.status === "kept") {
      const reason =
        entry.reason === "unsettled-thread"
          ? "not-settled"
          : entry.reason === "missing"
            ? "missing"
            : entry.reason === "symbolic-link"
              ? "symbolic-link"
              : entry.reason === "not-checked"
                ? "not-fully-checked"
                : "not-managed";
      return { entry, freedBytes: 0, incomplete: false, reason };
    }
    if (approved.length === 0) {
      const reason = tooLarge ? "too-large" : incomplete ? "not-fully-checked" : "nothing-matched";
      return { entry, freedBytes: 0, incomplete, reason };
    }
    return {
      entry,
      freedBytes,
      incomplete,
      reason: freedBytes > 0 || incomplete ? null : "frees-nothing",
    };
  });
  const cleaned = rows
    .filter((row) => row.reason === null)
    .sort((left, right) => right.freedBytes - left.freedBytes);
  return {
    cleaned,
    notCleaned: rows.filter((row) => row.reason !== null),
    totalBytes: cleaned.reduce((sum, row) => sum + row.freedBytes, 0),
    incomplete: cleaned.some((row) => row.incomplete),
  };
}

/**
 * Selected paths in a worktree that at least one approved pattern matches,
 * leaving out paths inside another approved path, whose bytes that path
 * already counts.
 */
export function worktreeCleanupApprovedSelection(
  entry: WorktreeCleanupPreviewEntry,
  approvedPatterns: ReadonlySet<string>,
) {
  const approved = (selected: WorktreeCleanupPreviewEntry["selected"][number]) =>
    selected.patterns.some((pattern) => approvedPatterns.has(pattern));
  return entry.selected.filter(
    (selected) => approved(selected) && !selectedAncestors(entry, selected).some(approved),
  );
}

/** The selected paths that contain this one, nearest first. */
function selectedAncestors(
  entry: WorktreeCleanupPreviewEntry,
  selected: WorktreeCleanupPreviewEntry["selected"][number],
) {
  const byPath = new Map(entry.selected.map((item) => [item.path, item]));
  const ancestors: WorktreeCleanupPreviewEntry["selected"][number][] = [];
  let parent = selected.insideSelected === null ? undefined : byPath.get(selected.insideSelected);
  while (parent !== undefined && !ancestors.includes(parent)) {
    ancestors.push(parent);
    parent = parent.insideSelected === null ? undefined : byPath.get(parent.insideSelected);
  }
  return ancestors;
}
