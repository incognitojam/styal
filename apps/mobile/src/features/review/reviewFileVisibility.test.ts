import { describe, expect, it } from "vite-plus/test";

import { getValidReviewFileIds } from "./reviewFileVisibility";
import type { ReviewRenderableFile } from "./reviewModel";

function makeFile(id: string): ReviewRenderableFile {
  return {
    id,
    cacheKey: id,
    path: id,
    previousPath: null,
    changeType: "change",
    additions: 0,
    deletions: 0,
    languageHint: null,
    additionLines: [],
    deletionLines: [],
    rows: [],
  };
}

describe("review file visibility", () => {
  it("defaults generated files and known lockfiles to collapsed", () => {
    const generatedFiles = [
      makeFile("src/generated.ts"),
      makeFile("packages/app/bun.lock"),
      makeFile("dist/app.js"),
    ];

    expect(getValidReviewFileIds(generatedFiles, undefined, ["src/generated.ts"])).toEqual([]);
    expect(getValidReviewFileIds(generatedFiles, ["packages/app/bun.lock"])).toEqual([
      "packages/app/bun.lock",
    ]);
  });
});
