import { describe, expect, it } from "vite-plus/test";

import { makeReferenceCache } from "./referenceCache.ts";

const REFERENCE = { repository: "pingdotgg/t3code", number: 6039 };

function answer(overrides: Partial<{ kind: "issue" | "pull-request" | null }> = {}) {
  return {
    repository: "pingdotgg/t3code",
    number: 6039,
    kind: "pull-request" as "issue" | "pull-request" | null,
    title: "A fix",
    state: "open" as const,
    url: "https://github.com/pingdotgg/t3code/pull/6039",
    ...overrides,
  };
}

describe("makeReferenceCache", () => {
  it("answers a reference a neighbouring body already resolved", () => {
    const cache = makeReferenceCache();
    cache.write(1000, "github.com", [answer()]);

    const read = cache.read(1000, "github.com", [REFERENCE]);

    expect(read.cached).toEqual([answer()]);
    expect(read.unanswered).toEqual([]);
  });

  it("asks again once an answer is stale, and keeps a missing one longer", () => {
    const cache = makeReferenceCache({ resolvedTtlMs: 100, missingTtlMs: 500 });
    cache.write(0, "github.com", [answer(), answer({ kind: null })]);

    // The second write replaced the first, so the entry now carries the missing lifetime.
    expect(cache.read(300, "github.com", [REFERENCE]).cached).toHaveLength(1);
    expect(cache.read(600, "github.com", [REFERENCE]).unanswered).toEqual([REFERENCE]);
  });

  it("keeps one host's answers away from another's, which spell numbers the same", () => {
    const cache = makeReferenceCache();
    cache.write(0, "github.com", [answer()]);

    expect(cache.read(0, "github.acme.test", [REFERENCE]).unanswered).toEqual([REFERENCE]);
  });

  it("says nothing about a reference nobody answered", () => {
    const cache = makeReferenceCache();
    cache.write(0, "github.com", []);

    expect(cache.read(0, "github.com", [REFERENCE])).toEqual({
      cached: [],
      unanswered: [REFERENCE],
    });
  });

  it("drops the oldest answers rather than growing without a bound", () => {
    const cache = makeReferenceCache({ capacity: 2 });
    for (const number of [1, 2, 3]) {
      cache.write(0, "github.com", [{ ...answer(), number }]);
    }

    expect(cache.size()).toBe(2);
    expect(
      cache.read(0, "github.com", [{ repository: REFERENCE.repository, number: 1 }]).unanswered,
    ).toHaveLength(1);
    expect(
      cache.read(0, "github.com", [{ repository: REFERENCE.repository, number: 3 }]).cached,
    ).toHaveLength(1);
  });
});
