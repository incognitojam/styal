import { describe, expect, it } from "vite-plus/test";

import { normalizeCommandOutput } from "./CommandOutputQuery.ts";

describe("normalizeCommandOutput", () => {
  it("returns Codex combined output with its exit code", () => {
    expect(
      normalizeCommandOutput({
        kind: "tool.completed",
        payload: {
          itemType: "command_execution",
          data: {
            item: {
              aggregatedOutput: "stdout line\nstderr line\n",
              exitCode: 7,
            },
          },
        },
      }),
    ).toEqual({
      status: "available",
      output: "stdout line\nstderr line\n",
      stdout: null,
      stderr: null,
      exitCode: 7,
    });
  });

  it("keeps ACP stdout and stderr separate", () => {
    expect(
      normalizeCommandOutput({
        kind: "tool.completed",
        payload: {
          itemType: "command_execution",
          status: "completed",
          data: {
            rawOutput: {
              stdout: "stdout line\n",
              stderr: "stderr line\n",
              exitCode: 2,
            },
          },
        },
      }),
    ).toEqual({
      status: "available",
      output: null,
      stdout: "stdout line\n",
      stderr: "stderr line\n",
      exitCode: 2,
    });
  });

  it("truncates long output in the middle", () => {
    const result = normalizeCommandOutput({
      kind: "tool.completed",
      payload: {
        itemType: "command_execution",
        status: "completed",
        data: {
          item: {
            aggregatedOutput: `start-${"x".repeat(300_000)}-end`,
          },
        },
      },
    });

    expect(result.output).toMatch(/^start-/u);
    expect(result.output).toContain("… output truncated …");
    expect(result.output).toMatch(/-end$/u);
  });
});
