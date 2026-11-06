import * as Effect from "effect/Effect";
import type { Toolkit } from "effect/ai";

import type { OrchestratorToolkit } from "../mcp/toolkits/orchestrator/tools.ts";
import * as AnalyticsService from "./AnalyticsService.ts";
import * as FeatureUsage from "./FeatureUsage.ts";

type Handlers = Toolkit.HandlersFrom<Toolkit.Tools<typeof OrchestratorToolkit>>;

/** Observes the wake each delegate_task call chooses; other tools pass through. */
export const observeHandlers = Effect.fnUntraced(function* (handlers: Handlers) {
  const analytics = yield* AnalyticsService.AnalyticsService;
  return {
    ...handlers,
    delegate_task: (input, context) =>
      FeatureUsage.observe(
        input.wake === "all"
          ? {
              feature: "delegated-wake",
              action: "delegate",
              source: "agent",
              wake: "all",
              wakeAfter: input.wakeAfterMs !== undefined,
            }
          : { feature: "delegated-wake", action: "delegate", source: "agent", wake: "each" },
        handlers.delegate_task(input, context),
      ).pipe(Effect.provideService(AnalyticsService.AnalyticsService, analytics)),
    create_threads: (input, context) =>
      input.threads.some((thread) => thread.reportBack === true)
        ? FeatureUsage.observe(
            { feature: "thread-reports", action: "opt_in", source: "agent" },
            handlers.create_threads(input, context),
          ).pipe(Effect.provideService(AnalyticsService.AnalyticsService, analytics))
        : handlers.create_threads(input, context),
    t3_thread_send: (input, context) =>
      handlers
        .t3_thread_send(input, context)
        .pipe(
          Effect.tap((result) =>
            result.report === true
              ? FeatureUsage.recordThreadReport({ kind: "sent", outcome: "delivered" }).pipe(
                  Effect.provideService(AnalyticsService.AnalyticsService, analytics),
                )
              : Effect.void,
          ),
        ),
    t3_thread_update: (input, context) =>
      input.action === "stop_reports" || input.action === "report_to_me"
        ? FeatureUsage.observe(
            {
              feature: "thread-reports",
              action: input.action === "stop_reports" ? "stop" : "restart",
              source: "agent",
            },
            handlers.t3_thread_update(input, context),
          ).pipe(Effect.provideService(AnalyticsService.AnalyticsService, analytics))
        : handlers.t3_thread_update(input, context),
  } satisfies Handlers;
});
