import { type RepositoryIdentity, SourceControlProviderKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { githubReferenceUrlLabel, githubRepositoryOf } from "./githubReferences.ts";

const identity = (overrides: Partial<RepositoryIdentity>): RepositoryIdentity => ({
  canonicalKey: "github.com/example/project",
  locator: {
    source: "git-remote",
    remoteName: "origin",
    remoteUrl: "git@github.com:example/project.git",
  },
  provider: SourceControlProviderKind.make("github"),
  ...overrides,
});

describe("githubRepositoryOf", () => {
  it("reads the host and repository of a GitHub checkout", () => {
    expect(githubRepositoryOf(identity({}))).toEqual({
      host: "github.com",
      repository: "example/project",
    });
    expect(githubRepositoryOf(identity({ canonicalKey: "github.example.com/team/app" }))).toEqual({
      host: "github.example.com",
      repository: "team/app",
    });
  });

  it("has nothing for another forge or no checkout", () => {
    expect(
      githubRepositoryOf(
        identity({
          provider: SourceControlProviderKind.make("gitlab"),
          canonicalKey: "gitlab.com/a/b",
        }),
      ),
    ).toBeUndefined();
    expect(githubRepositoryOf(null)).toBeUndefined();
  });
});

describe("githubReferenceUrlLabel", () => {
  const repository = { host: "github.com", repository: "example/project" };

  it("says #123 at home and owner/repo#123 elsewhere, naming comments and reviews", () => {
    expect(githubReferenceUrlLabel(repository, "https://github.com/Example/Project/pull/4")).toBe(
      "#4",
    );
    expect(
      githubReferenceUrlLabel(repository, "https://github.com/other/repo/issues/5#issuecomment-9"),
    ).toBe("other/repo#5 (comment)");
    expect(
      githubReferenceUrlLabel(
        repository,
        "https://github.com/example/project/pull/6#pullrequestreview-1",
      ),
    ).toBe("#6 (review)");
  });

  it("only knows github.com without a repository", () => {
    expect(githubReferenceUrlLabel(undefined, "https://github.com/example/project/pull/4")).toBe(
      "example/project#4",
    );
    expect(
      githubReferenceUrlLabel(undefined, "https://github.example.com/example/project/pull/4"),
    ).toBeNull();
  });
});
