import { describe, expect, it } from "vite-plus/test";
import { imageIntersectsViewport } from "./pullRequestImageVisibility";

describe("PR image visibility", () => {
  it.each([
    ["visible", { x: 10, y: 20, width: 174, height: 112 }, true],
    ["partially visible", { x: 310, y: 20, width: 174, height: 112 }, true],
    ["below screen", { x: 10, y: 640, width: 174, height: 112 }, false],
    ["past strip", { x: 320, y: 20, width: 174, height: 112 }, false],
    ["zero size", { x: 10, y: 20, width: 0, height: 112 }, false],
    ["collapsed description", { x: 10, y: 241, width: 174, height: 112 }, false],
  ])("loads only %s images inside every clipping boundary", (_name, image, expected) => {
    expect(
      imageIntersectsViewport(image, [
        { x: 0, y: 0, width: 320, height: 640 },
        { x: 0, y: 0, width: 320, height: 240 },
      ]),
    ).toBe(expected);
  });
});
