import type { OrchestrationV2ThreadSettleReason } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as AnalyticsService from "./AnalyticsService.ts";

/** The automatic settlement rule that settled a thread. */
export type AutoSettleRule = "merged" | "closed" | "inactivity";

/** Why a thread was settled before an un-settle, as a fixed category. */
export type PreviousSettleReason = "user" | AutoSettleRule | "unknown";

/**
 * Records one server auto-settle with its rule, and the configured threshold
 * for inactivity. Thread, project and pull request identifiers are never sent.
 */
export const recordAutoSettle = (rule: AutoSettleRule, afterDays: number | null) =>
  Effect.gen(function* () {
    const analytics = yield* AnalyticsService.AnalyticsService;
    yield* analytics.record("server.thread.settled", {
      reason: rule,
      ...(rule === "inactivity" && afterDays !== null ? { afterDays } : {}),
    });
  }).pipe(Effect.ignoreCause);

/**
 * The `previousSettleReason` of an un-settle. `unknown` covers threads that
 * were not settled and settles recorded before reasons existed.
 */
export function previousSettleReason(
  thread:
    | {
        readonly settledOverride: "settled" | "active" | null;
        readonly settleReason?: OrchestrationV2ThreadSettleReason | null | undefined;
      }
    | undefined,
): PreviousSettleReason {
  if (thread?.settledOverride !== "settled") return "unknown";
  switch (thread.settleReason?.kind) {
    case "user":
      return "user";
    case "pull_request":
      return thread.settleReason.state;
    case "inactivity":
      return "inactivity";
    default:
      return "unknown";
  }
}
