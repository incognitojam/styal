import { describe, expect, it } from "vite-plus/test";
import { MARKDOWN_IMAGE_ROW_MIN_HEIGHT, resolveMarkdownImageRowHeight } from "./markdownImageSize";

const phone = { width: 1080, height: 2400 };
const desktop = { width: 1600, height: 1000 };

describe("resolveMarkdownImageRowHeight", () => {
  it.each([
    ["portrait pair: the portraits' own height", [phone, phone], 170, (170 * 2400) / 1080],
    ["landscape pair: the landscapes' own height", [desktop, desktop], 170, (170 * 1000) / 1600],
    ["landscape beside portrait: the floor", [desktop, phone], 170, MARKDOWN_IMAGE_ROW_MIN_HEIGHT],
    ["one image: its own height", [phone], 380, 480],
    ["nothing reported yet", [], 170, null],
  ])("%s", (_, sizes, tileWidth, expected) => {
    const height = resolveMarkdownImageRowHeight(sizes, tileWidth);
    if (expected === null) expect(height).toBeNull();
    else expect(height).toBeCloseTo(expected);
  });
});
