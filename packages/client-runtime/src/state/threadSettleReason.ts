import type { OrchestrationV2ThreadSettleReason } from "@t3tools/contracts";

function dayCount(days: number): string {
  return days === 1 ? "1 day" : `${days} days`;
}

/** Null for explicit settles and settles recorded before reasons existed. */
export function settleReasonLabel(
  reason: OrchestrationV2ThreadSettleReason | null | undefined,
): string | null {
  switch (reason?.kind) {
    case "pull_request":
      return `PR #${reason.number} ${reason.state}`;
    case "inactivity":
      return `Idle ${dayCount(reason.days)}`;
    default:
      return null;
  }
}

/** Completes "<title> settled …" for an automatic settle; null otherwise. */
export function settleReasonSentence(
  reason: OrchestrationV2ThreadSettleReason | null | undefined,
): string | null {
  switch (reason?.kind) {
    case "pull_request":
      return `because PR #${reason.number} ${reason.state}`;
    case "inactivity":
      return `after ${dayCount(reason.days)} without activity`;
    default:
      return null;
  }
}
