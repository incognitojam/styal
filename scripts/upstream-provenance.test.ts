import { assert, describe, it } from "@effect/vitest";

import { parseSourceCommitInput, parseUpstreamProvenance } from "./upstream-provenance.ts";

describe("upstream commit provenance", () => {
  it("reads full commit SHAs alongside PR provenance without treating incidental references as sources", () => {
    const first = "a".repeat(40);
    const second = "b".repeat(40);
    const source = parseUpstreamProvenance([
      `fix: synthetic port\n\nCompare with ${"c".repeat(40)}.\n\nUpstream-PR: 123\nupstream-commit: ${second}, ${first}, ${second}`,
    ]);
    assert.deepEqual(source.commitShas, [first, second]);
    assert.deepEqual(source.pullRequestNumbers, [123]);
    assert.deepEqual(source.errors, []);
    assert.deepEqual(parseSourceCommitInput(`${second}, ${first}, ${second}`), [first, second]);
    assert.deepEqual(parseSourceCommitInput(""), []);
  });

  it("rejects missing, abbreviated, uppercase, and malformed commit trailers", () => {
    for (const value of ["", "abcdef0", "A".repeat(40), `${"a".repeat(40)}, nope`]) {
      const source = parseUpstreamProvenance([`fix: port\n\nUpstream-Commit: ${value}`]);
      assert.deepEqual(source.commitShas, []);
      assert.lengthOf(source.errors, 1);
    }
  });

  it("reads provenance trailers wrapped by GitHub", () => {
    const first = "a".repeat(40);
    const second = "b".repeat(40);
    const source = parseUpstreamProvenance([
      [
        "fix: synthetic squash commit",
        "",
        "Upstream-PR: 5302, 5769, 9843,",
        "10105, 10285, 10289,",
        "10301, 11316",
        `Upstream-Commit: ${first},`,
        second,
      ].join("\n"),
    ]);

    assert.deepEqual(
      source.pullRequestNumbers,
      [5302, 5769, 9843, 10105, 10285, 10289, 10301, 11316],
    );
    assert.deepEqual(source.commitShas, [first, second]);
    assert.deepEqual(source.errors, []);
  });

  it("does not treat unrelated numeric lines after complete trailers as provenance", () => {
    const source = parseUpstreamProvenance([
      "fix: synthetic squash commit\n\nUpstream-PR: 5302\n5769, 9843",
    ]);

    assert.deepEqual(source.pullRequestNumbers, [5302]);
    assert.deepEqual(source.errors, []);
  });
});
