import { describe, expect, it } from "vite-plus/test";

import {
  DICTATION_VOCABULARY_LIMIT,
  extractIdentifiers,
  rankIdentifiers,
} from "./dictationVocabulary";

describe("extractIdentifiers", () => {
  it("finds camelCase, PascalCase and snake_case identifiers", () => {
    expect(
      extractIdentifiers("call mapError on the FileSystem then read thread_id and plain words"),
    ).toEqual(["mapError", "FileSystem", "thread_id"]);
  });

  it("ignores ordinary words and single-word lowercase tokens", () => {
    expect(extractIdentifiers("the quick brown fox jumps")).toEqual([]);
  });
});

describe("rankIdentifiers", () => {
  it("orders by frequency so collision collapsing keeps the common form", () => {
    expect(rankIdentifiers(["threadId", "thread_id", "threadId"])).toEqual([
      "threadId",
      "thread_id",
    ]);
  });

  it("caps at the measured vocabulary limit", () => {
    // Repo-scale vocabularies damaged more than a third of utterances in the
    // spike (finding 12); the cap is the guard against that.
    const many = Array.from({ length: 300 }, (_, index) => `someIdentifier${index}`);
    expect(rankIdentifiers(many)).toHaveLength(DICTATION_VOCABULARY_LIMIT);
  });
});
