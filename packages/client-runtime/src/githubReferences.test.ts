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

  const label = (context: typeof repository | undefined, url: string, text = url) =>
    githubReferenceUrlLabel(context, url, text);

  it("says #123 at home and owner/repo#123 elsewhere, naming comments and reviews", () => {
    expect(label(repository, "https://github.com/Example/Project/pull/4")).toBe("#4");
    expect(label(repository, "https://github.com/other/repo/issues/5#issuecomment-9")).toBe(
      "other/repo#5 (comment)",
    );
    expect(label(repository, "https://github.com/example/project/pull/6#pullrequestreview-1")).toBe(
      "#6 (review)",
    );
  });

  it("names the repository behind a bare #123 label, and keeps any other label", () => {
    expect(label(repository, "https://github.com/other/repo/pull/7", "#7")).toBe("other/repo#7");
    expect(label(repository, "https://github.com/other/repo/pull/7", "#8")).toBeNull();
    expect(label(repository, "https://github.com/other/repo/pull/7", "the fix")).toBeNull();
  });

  it("only knows github.com without a repository", () => {
    expect(label(undefined, "https://github.com/example/project/pull/4")).toBe("example/project#4");
    expect(label(undefined, "https://github.example.com/example/project/pull/4")).toBeNull();
  });
});
