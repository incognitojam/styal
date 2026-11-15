import { type ProjectId, type ServerSettings, WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { createAtomCommandScheduler, createEnvironmentRpcCommand } from "./runtime.ts";

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
    approve: createEnvironmentRpcCommand(runtime, {
      label: "worktree-cleanup:approve",
      tag: WS_METHODS.projectsWorktreeCleanupApprove,
      ...serial,
    }),
    revoke: createEnvironmentRpcCommand(runtime, {
      label: "worktree-cleanup:revoke",
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
