import { describe, expect, it } from "vite-plus/test";

import { labelGithubReferenceUrls } from "./githubReferenceUrlLabels";

const repository = { host: "github.com", repository: "example/project" };

describe("labelGithubReferenceUrls", () => {
  it("labels bare issue and pull request URLs as GitHub shorthand", () => {
    expect(
      labelGithubReferenceUrls(
        "Opened https://github.com/example/project/pull/42. See <https://github.com/other/repo_x/issues/7#issuecomment-1> too.",
        repository,
      ),
    ).toBe(
      "Opened [#42](https://github.com/example/project/pull/42). See [other/repo\\_x#7 (comment)](https://github.com/other/repo_x/issues/7#issuecomment-1) too.",
    );
  });

  it("leaves written labels, deeper pages, query strings and code alone", () => {
    const markdown = [
      "[the fix](https://github.com/example/project/pull/42)",
      "https://github.com/example/project/pull/42/files",
      "https://github.com/example/project/pull/42?w=1",
      "`https://github.com/example/project/pull/42`",
      "```\nhttps://github.com/example/project/pull/42\n```",
    ].join("\n\n");
    expect(labelGithubReferenceUrls(markdown, repository)).toBe(markdown);
  });

  it("names the repository when the thread has no GitHub repository", () => {
    expect(labelGithubReferenceUrls("https://github.com/example/project/pull/42", undefined)).toBe(
      "[example/project#42](https://github.com/example/project/pull/42)",
    );
  });
});
