import * as Effect from "effect/Effect";
import type { Toolkit } from "effect/ai";

import * as FeedbackService from "../../../feedback/FeedbackService.ts";
import * as AnalyticsService from "../../../telemetry/AnalyticsService.ts";
import * as FeatureUsage from "../../../telemetry/FeatureUsage.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { FeedbackToolkit } from "./tools.ts";

type Handlers = Toolkit.HandlersFrom<Toolkit.Tools<typeof FeedbackToolkit>>;

const handlers = {
  report_styal_issue: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      const scope = yield* McpInvocationContext.requireThreadScope(
        invocation,
        "report_styal_issue",
      );
      const feedback = yield* FeedbackService.FeedbackService;
      return yield* feedback.reportFromAgent(scope.thread.threadId, input);
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof FeedbackToolkit.tools>;

export const observeHandlers = Effect.fnUntraced(function* (inner: Handlers) {
  const analytics = yield* AnalyticsService.AnalyticsService;
  return {
    report_styal_issue: (input, context) =>
      FeatureUsage.observe(
        { feature: "feedback", action: "report", source: "agent" },
        inner.report_styal_issue(input, context),
        {},
        (result) => ({ feedbackStatus: result.status }),
      ).pipe(Effect.provideService(AnalyticsService.AnalyticsService, analytics)),
  } satisfies Handlers;
});

export const layer = McpToolAccess.toLayer(
  FeedbackToolkit,
  McpToolAccess.wrapHandlers(handlers, observeHandlers),
);
