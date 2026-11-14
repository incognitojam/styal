import * as Effect from "effect/Effect";

import * as McpToolAccess from "../../McpToolAccess.ts";
import { AGENT_GUIDES } from "./guides.ts";
import { GuideToolkit } from "./tools.ts";

const handlers = {
  read_styal_guide: McpToolAccess.reads(({ topic }) =>
    Effect.succeed({ guide: AGENT_GUIDES[topic] }),
  ),
} satisfies McpToolAccess.Handlers<typeof GuideToolkit.tools>;

export const layer = McpToolAccess.toLayer(GuideToolkit, handlers);
