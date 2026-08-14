import { describe, expect, it } from "vite-plus/test";

import {
  githubReferenceHref,
  missingGithubReferenceTitle,
  type GithubReferenceResolution,
} from "./githubReferenceLinks";

const WRITTEN = "https://github.com/pingdotgg/t3code/issues/6039";

function resolved(url: string | null): GithubReferenceResolution {
  return {
    status: "resolved",
    reference: {
      repository: "pingdotgg/t3code",
      number: 6039,
      kind: "pull-request",
      title: "A fix",
      state: "open",
      url,
    },
  };
}

/**
 * Where a reference is followed to is the whole of what resolving changes, and the pull request
 * case is the one that decides whether it opens here or in a browser: only the host's own address
 * carries `/pull/`, which is what the page recognises.
 */
describe("githubReferenceHref", () => {
  it("follows the address the host gave, which is what makes a pull request recognisable", () => {
    const href = "https://github.com/pingdotgg/t3code/pull/6039";

    expect(githubReferenceHref(resolved(href), WRITTEN)).toBe(href);
  });

  it("keeps the link as written whenever the host said nothing usable", () => {
    for (const resolution of [
      { status: "unresolved" },
      { status: "missing" },
      resolved(null),
    ] satisfies ReadonlyArray<GithubReferenceResolution>) {
      expect(githubReferenceHref(resolution, WRITTEN)).toBe(WRITTEN);
    }
  });
});

describe("missingGithubReferenceTitle", () => {
  it("explains only the reference the host said is not there", () => {
    expect(missingGithubReferenceTitle({ status: "missing" }, "#6039")).toBe(
      "Could not find #6039 — it may be private or deleted.",
    );
    expect(missingGithubReferenceTitle({ status: "unresolved" }, "#6039")).toBeUndefined();
  });
});
