import { expect, it } from "vite-plus/test";

import { cachedPullRequestLabelCandidates } from "./pullRequestLabelPicker.logic";

it("keeps applied labels outside another PR's truncated catalogue available for removal", () => {
  const candidates = cachedPullRequestLabelCandidates(
    [
      { name: "bug", color: "d73a4a", description: "Something is broken" },
      { name: "documentation", color: "0075ca", description: "Improve documentation" },
    ],
    [
      { name: "outside-page", color: "a2eeef" },
      { name: "documentation", color: "0075ca" },
    ],
  );
  expect(candidates).toEqual([
    { name: "outside-page", color: "a2eeef", description: null, isApplied: true },
    { name: "bug", color: "d73a4a", description: "Something is broken", isApplied: false },
    {
      name: "documentation",
      color: "0075ca",
      description: "Improve documentation",
      isApplied: true,
    },
  ]);
  expect(
    candidates.filter((candidate) => candidate.isApplied).map((candidate) => candidate.name),
  ).toEqual(["outside-page", "documentation"]);
});

it("includes the current PR's applied labels when the cached catalogue is empty", () => {
  expect(cachedPullRequestLabelCandidates([], [{ name: "new-label", color: null }])).toEqual([
    { name: "new-label", color: null, description: null, isApplied: true },
  ]);
});
