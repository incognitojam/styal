import { describe, expect, it } from "vite-plus/test";

import {
  deriveCommandFileReadPresentation,
  deriveToolActivityPresentation,
} from "./toolActivity.ts";

describe("toolActivity", () => {
  it("normalizes command tools to a stable ran-command label", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "command_execution",
        title: "Terminal",
        detail: "Terminal",
        data: {
          command: "bun run lint",
        },
        fallbackSummary: "Terminal",
      }),
    ).toEqual({
      summary: "Ran command",
      detail: "bun run lint",
    });
  });

  it("uses structured file paths for read-file tools when available", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "Read File",
        detail: "Read File",
        data: {
          kind: "read",
          locations: [{ path: "/tmp/app.ts" }],
        },
        fallbackSummary: "Read File",
      }),
    ).toEqual({
      summary: "Read file",
      detail: "/tmp/app.ts",
    });
  });

  it("drops duplicated generic read-file detail when no path is available", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "Read File",
        detail: "Read File",
        data: {
          kind: "read",
          rawInput: {},
        },
        fallbackSummary: "Read File",
      }),
    ).toEqual({
      summary: "Read file",
    });
  });

  it("presents a single-file sed print range as a file read", () => {
    expect(deriveCommandFileReadPresentation("sed -n '1,240p' /workspace/src/app.ts")).toEqual({
      summary: "Read file",
      detail: "/workspace/src/app.ts",
      path: "/workspace/src/app.ts",
    });
    expect(deriveCommandFileReadPresentation("/usr/bin/sed -n 40p -- 'docs/My File.md'")).toEqual({
      summary: "Read file",
      detail: "docs/My File.md",
      path: "docs/My File.md",
    });
    expect(deriveCommandFileReadPresentation("Bash: sed -n '1,12p' src/app.ts")).toEqual({
      summary: "Read file",
      detail: "src/app.ts",
      path: "src/app.ts",
    });
  });

  it("leaves general sed commands classified as commands", () => {
    for (const command of [
      "sed 's/foo/bar/' app.ts",
      "sed -n '1,40p' app.ts other.ts",
      "sed -n '1,40p' app.ts | head",
      "sed -n '$p' app.ts",
    ]) {
      expect(deriveCommandFileReadPresentation(command)).toBeUndefined();
    }
  });
});
