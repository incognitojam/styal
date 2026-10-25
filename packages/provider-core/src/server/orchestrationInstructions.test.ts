import { assert, describe, it } from "@effect/vitest";

import {
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
  renderProviderToolInstructions,
  t3OrchestrationSystemPrompt,
} from "./orchestrationInstructions.ts";

describe("T3 orchestration provider instructions", () => {
  it("only exposes the system prompt when the T3 MCP server is attached", () => {
    assert.equal(t3OrchestrationSystemPrompt(false), undefined);
    assert.equal(
      t3OrchestrationSystemPrompt(true),
      renderProviderToolInstructions(T3_CODE_ORCHESTRATION_INSTRUCTIONS),
    );
    assert.include(t3OrchestrationSystemPrompt(true)!, "## styal orchestration");
    assert.notInclude(t3OrchestrationSystemPrompt(true)!, "T3");
  });

  it("names the session's MCP namespace", () => {
    const text = "`mcp__t3_code__delegate_task` on the `t3-code` server";
    assert.equal(
      renderProviderToolInstructions(text, "t3-code"),
      "`mcp__t3_code__delegate_task` on the `t3-code` server",
    );
    assert.equal(
      renderProviderToolInstructions(text),
      "`mcp__styal__delegate_task` on the `styal` server",
    );
  });
});
