import { describe, expect, it } from "@effect/vitest";
import { pullRequestImageWidth } from "./pullRequestImagePreview.ts";

describe("pullRequestImageWidth", () => {
  it.each([
    [174, 3, 640],
    [360, 3, 1440],
    [320, 1, 320],
    [800, 1, 960],
    [3000, 2, 3840],
  ])("selects a bounded width for %s points at %sx", (width, ratio, expected) => {
    expect(pullRequestImageWidth(width, ratio)).toBe(expected);
  });
});
