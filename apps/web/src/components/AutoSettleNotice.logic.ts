import type {
  OrchestrationV2ThreadAutoSettleReason,
  OrchestrationV2ThreadSettleReason,
} from "@t3tools/contracts";

/** The shell fields the notice reads. */
export interface AutoSettleNoticeThread {
  readonly title: string;
  readonly archivedAt: string | null;
  readonly settledOverride: "settled" | "active" | null;
  readonly settleReason?: OrchestrationV2ThreadSettleReason | null | undefined;
  /** Set to the settle time when the thread settles. */
  readonly updatedAt: string;
  readonly lineage: { readonly relationshipToParent: "fork" | "subagent" | null };
}

export type AutoSettleNotice<T extends AutoSettleNoticeThread> =
  | {
      readonly kind: "single";
      readonly thread: T;
      readonly reason: OrchestrationV2ThreadAutoSettleReason;
    }
  | { readonly kind: "combined"; readonly threads: ReadonlyArray<T> };

function automaticReason(
  reason: OrchestrationV2ThreadSettleReason | null | undefined,
): OrchestrationV2ThreadAutoSettleReason | null {
  return reason?.kind === "pull_request" || reason?.kind === "inactivity" ? reason : null;
}

/**
 * The one-time explanation of automatic settlement. Counts only settled
 * sidebar threads with a recorded automatic reason that settled at or after
 * `since`, the time this device first ran a version with the notice, so
 * older settles never flood an existing user. Nothing once dismissed.
 */
export function resolveAutoSettleNotice<T extends AutoSettleNoticeThread>(input: {
  readonly threads: ReadonlyArray<T>;
  readonly since: string | null;
  readonly dismissed: boolean;
}): AutoSettleNotice<T> | null {
  if (input.dismissed || input.since === null) return null;
  const sinceMs = Date.parse(input.since);
  if (Number.isNaN(sinceMs)) return null;
  const settled = input.threads.filter(
    (thread) =>
      thread.settledOverride === "settled" &&
      thread.archivedAt === null &&
      thread.lineage.relationshipToParent !== "subagent" &&
      automaticReason(thread.settleReason) !== null &&
      Date.parse(thread.updatedAt) >= sinceMs,
  );
  const [first] = settled;
  if (first === undefined) return null;
  if (settled.length > 1) return { kind: "combined", threads: settled };
  const reason = automaticReason(first.settleReason);
  return reason === null ? null : { kind: "single", thread: first, reason };
}
