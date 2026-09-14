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
});
