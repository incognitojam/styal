import * as Effect from "effect/Effect";
import type { Toolkit } from "effect/ai";

import * as HardwareService from "../hardware/HardwareService.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import type { HardwareToolkit } from "../mcp/toolkits/hardware/tools.ts";
import * as AnalyticsService from "./AnalyticsService.ts";
import * as FeatureUsage from "./FeatureUsage.ts";

type Handlers = Toolkit.HandlersFrom<Toolkit.Tools<typeof HardwareToolkit>>;

/**
 * Observe each hardware tool as one operation, refusals included. Proxied
 * script calls are not counted: a calibration run makes hundreds.
 */
export const observeHandlers = Effect.fnUntraced(function* (handlers: Handlers) {
  const analytics = yield* AnalyticsService.AnalyticsService;
  const observe = <A, E, R>(
    usage: Omit<
      Extract<Parameters<typeof FeatureUsage.observe>[0], { feature: "hardware" }>,
      "feature" | "source"
    >,
    effect: Effect.Effect<A, E, R>,
  ) =>
    FeatureUsage.observe({ feature: "hardware", source: "agent", ...usage }, effect).pipe(
      Effect.provideService(AnalyticsService.AnalyticsService, analytics),
    );
  return {
    hardware_list: (input, context) =>
      observe({ action: "list" }, handlers.hardware_list(input, context)),
    hardware_acquire: (input, context) =>
      observe({ action: "acquire" }, handlers.hardware_acquire(input, context)),
    hardware_call: (input, context) =>
      // The tier the calling thread sees, worktree overrides included. Tool calls
      // are few, unlike proxied ones, so the extra lookup is cheap.
      Effect.gen(function* () {
        const invocation = yield* McpInvocationContext.McpInvocationContext;
        const hardware = yield* HardwareService.HardwareService;
        const devices =
          invocation.thread === undefined
            ? []
            : yield* hardware
                .listForThread(invocation.thread.threadId, input.device)
                .pipe(Effect.orElseSucceed(() => []));
        return devices[0]?.actions.find((action) => action.name === input.action)?.tier;
      }).pipe(
        Effect.flatMap((hardwareTier) =>
          observe({ action: "call", hardwareTier }, handlers.hardware_call(input, context)),
        ),
      ),
    hardware_release: (input, context) =>
      observe({ action: "release" }, handlers.hardware_release(input, context)),
  } satisfies Handlers;
});
