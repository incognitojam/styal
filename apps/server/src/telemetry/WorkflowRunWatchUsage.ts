import * as Effect from "effect/Effect";
import type { Toolkit } from "effect/ai";

import type {
  PullRequestsToolkit,
  WatchWorkflowRunResult,
} from "../mcp/toolkits/pullRequests/tools.ts";
import * as AnalyticsService from "./AnalyticsService.ts";
import * as FeatureUsage from "./FeatureUsage.ts";

type Handlers = Toolkit.HandlersFrom<Toolkit.Tools<typeof PullRequestsToolkit>>;

const watchResult = (result: WatchWorkflowRunResult): FeatureUsage.WorkflowRunWatchResult =>
  result.conclusion !== null
    ? "already_completed"
    : result.wasWatching
      ? result.watching
        ? "already_watching"
        : "stopped"
      : result.watching
        ? "started"
        : "not_watching";

/** Observes the workflow run tools; the pull request tools pass through unchanged. */
export const observeHandlers = Effect.fnUntraced(function* (handlers: Handlers) {
  const analytics = yield* AnalyticsService.AnalyticsService;
  const observe = <E, R>(
    action: "watch" | "unwatch",
    effect: Effect.Effect<WatchWorkflowRunResult, E, R>,
  ) =>
    FeatureUsage.observe(
      { feature: "workflow-run-watch", action, source: "agent" },
      effect,
      {},
      (result) => ({ watchResult: watchResult(result) }),
    ).pipe(Effect.provideService(AnalyticsService.AnalyticsService, analytics));
  return {
    ...handlers,
    watch_workflow_run: (input, context) =>
      observe("watch", handlers.watch_workflow_run(input, context)),
    unwatch_workflow_run: (input, context) =>
      observe("unwatch", handlers.unwatch_workflow_run(input, context)),
  } satisfies Handlers;
});

/** How a watch ended without the agent calling unwatch_workflow_run. */
export type WorkflowRunWatchEnd =
  | { readonly reason: "completed"; readonly conclusion: string | null }
  | { readonly reason: "unreadable" | "stopped" };

const CONCLUSIONS = new Set(["success", "failure", "cancelled", "timed_out", "skipped"]);

/**
 * Records one ended watch: why it ended, the run's conclusion as a fixed category, and how long
 * it was watched. `stopped` is anything outside the reactor: unwatch, settle, archive or Stop.
 */
export const recordEnd = (end: WorkflowRunWatchEnd, watchedMs: number) =>
  Effect.gen(function* () {
    const analytics = yield* AnalyticsService.AnalyticsService;
    yield* analytics.record("feature.used", {
      feature: "workflow-run-watch",
      action: "end",
      source: "system",
      endReason: end.reason,
      ...(end.reason === "completed"
        ? {
            conclusion:
              end.conclusion !== null && CONCLUSIONS.has(end.conclusion) ? end.conclusion : "other",
          }
        : {}),
      watchedMinutes: Math.max(0, Math.round(watchedMs / 60_000)),
    });
  }).pipe(Effect.ignoreCause);
