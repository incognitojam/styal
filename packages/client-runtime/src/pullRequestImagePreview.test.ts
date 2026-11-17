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

it.each([
  { width: "120", height: "40", expected: { width: 120, height: 40 } },
  { width: null, height: null, expected: undefined },
  { width: "0", height: "40", expected: undefined },
])(
  "reads tiny response dimensions with an old-server fallback: $width × $height",
  async ({ width, height, expected }) => {
    const { fetchPullRequestPlaceholder } = await import("./pullRequestImagePreview.ts");
    const headers = new Headers({ "content-type": "image/webp" });
    if (width) headers.set("x-styal-image-source-width", width);
    if (height) headers.set("x-styal-image-source-height", height);
    const fetcher: typeof globalThis.fetch = async () =>
      new Response(new Uint8Array([1, 2, 3]), { headers });
    const result = await fetchPullRequestPlaceholder(
      "https://example.test/tiny",
      new AbortController().signal,
      fetcher,
    );
    expect(result.sourceDimensions).toEqual(expected);
    expect(result.uri).toBe("data:image/webp;base64,AQID");
  },
);
