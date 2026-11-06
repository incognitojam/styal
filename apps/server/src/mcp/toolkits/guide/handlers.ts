import * as Effect from "effect/Effect";
import type { Toolkit } from "effect/ai";

import * as AnalyticsService from "../../../telemetry/AnalyticsService.ts";
import * as FeatureUsage from "../../../telemetry/FeatureUsage.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { AGENT_GUIDES } from "./guides.ts";
import { GuideToolkit } from "./tools.ts";

type Handlers = Toolkit.HandlersFrom<Toolkit.Tools<typeof GuideToolkit>>;

const handlers = {
  read_styal_guide: McpToolAccess.reads(({ topic }) =>
    Effect.succeed({ guide: AGENT_GUIDES[topic] }),
  ),
} satisfies McpToolAccess.Handlers<typeof GuideToolkit.tools>;

const observeHandlers = Effect.fnUntraced(function* (inner: Handlers) {
  const analytics = yield* AnalyticsService.AnalyticsService;
  return {
    read_styal_guide: (input, context) =>
      FeatureUsage.observe(
        { feature: "agent-guides", action: "read", source: "agent", guideTopic: input.topic },
        inner.read_styal_guide(input, context),
      ).pipe(Effect.provideService(AnalyticsService.AnalyticsService, analytics)),
  } satisfies Handlers;
});

export const layer = McpToolAccess.toLayer(
  GuideToolkit,
  McpToolAccess.wrapHandlers(handlers, observeHandlers),
);
