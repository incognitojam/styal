import type { OrchestratorFixtureInput } from "../shared.ts";
import { GROK_BACKGROUND_BASH_PROMPT } from "../grok_background_bash/input.ts";

// Recorded from Grok 1.0.44, which starts its `task-completed-*` reply within ~2s, inside the
// finish debounce while run 1 is still held. Finish receipts wait for the wake completion callback
// so child IO cannot create a false quiet gap. The reply must settle run 1 and open a
// continuation run instead of streaming into the held root run.
export function grokBackgroundBashFastWakeInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: GROK_BACKGROUND_BASH_PROMPT },
      { type: "finish_held_run", targetRunIndex: 1, status: "completed" },
      { type: "finish_held_run", targetRunIndex: 2, status: "completed" },
    ],
  };
}
