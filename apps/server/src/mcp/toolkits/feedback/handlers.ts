import * as Effect from "effect/Effect";

import * as FeedbackService from "../../../feedback/FeedbackService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { FeedbackToolkit } from "./tools.ts";

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

export const layer = McpToolAccess.toLayer(FeedbackToolkit, handlers);
