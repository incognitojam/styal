import { describe, expect, it } from "vite-plus/test";

import { findMentionedTimeSpans, markMentionedTimeSpans } from "./mentionedTimeSpans.ts";

describe("findMentionedTimeSpans", () => {
  it("finds clock-like spans in prose and leaves code alone", () => {
    const text =
      "The call took 17:25 and started at 9pm, around noon UK time.\n\n```\nlogged 14:00\n```\n\nRun `sleep 10:00` then check 8:05.";
    expect(findMentionedTimeSpans(text).map((span) => span.text)).toEqual([
      "17:25",
      "9pm",
      "noon",
      "8:05",
    ]);
  });

  it("skips line:column references, versions and ratios", () => {
    expect(findMentionedTimeSpans("see src/a.ts:12:34, v1:20 and 16:9 screens")).toEqual([]);
  });

  it("tags spans so the number cannot run into the time", () => {
    const text = "Lid closed 18:14–18:24.";
    expect(markMentionedTimeSpans(text, findMentionedTimeSpans(text))).toBe(
      "Lid closed [s1]⟦18:14⟧–[s2]⟦18:24⟧.",
    );
  });
});
