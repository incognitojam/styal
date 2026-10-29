import * as Effect from "effect/Effect";
import type { Toolkit } from "effect/ai";

import type { OrchestratorToolkit } from "../mcp/toolkits/orchestrator/tools.ts";
import * as AnalyticsService from "./AnalyticsService.ts";
import * as FeatureUsage from "./FeatureUsage.ts";

type Handlers = Toolkit.HandlersFrom<Toolkit.Tools<typeof OrchestratorToolkit>>;

/** Observes delegate_task calls that use wake=all; other calls and tools pass through. */
export const observeHandlers = Effect.fnUntraced(function* (handlers: Handlers) {
  const analytics = yield* AnalyticsService.AnalyticsService;
  return {
    ...handlers,
    delegate_task: (input, context) =>
      input.wake === "all"
        ? FeatureUsage.observe(
            {
              feature: "delegated-wake-all",
              action: "delegate",
              source: "agent",
              wakeAfter: input.wakeAfterMs !== undefined,
            },
            handlers.delegate_task(input, context),
          ).pipe(Effect.provideService(AnalyticsService.AnalyticsService, analytics))
        : handlers.delegate_task(input, context),
  } satisfies Handlers;
});
