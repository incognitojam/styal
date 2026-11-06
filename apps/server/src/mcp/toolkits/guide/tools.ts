import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import { AgentGuideTopic } from "./guides.ts";

const GuideReadTool = Tool.make("read_styal_guide", {
  description:
    "Read before setting up or explaining a styal feature. `project-setup`: styal.json, actions, worktree setup, t3.json migration. `troubleshooting`: doctor, triage.",
  parameters: Schema.Struct({ topic: AgentGuideTopic }),
  success: Schema.Struct({ guide: Schema.String }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const GuideToolkit = Toolkit.make(GuideReadTool);
