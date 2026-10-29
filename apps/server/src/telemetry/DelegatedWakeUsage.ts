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
  } satisfies Handlers;
});
