import { describe, expect, it } from "vite-plus/test";
import {
  toGitHubResolvedReference,
  missingGitHubReference,
  splitRepository,
} from "./gitHubReferences.ts";
const reference = { repository: "acme/web", number: 7 };
describe("GitHub reference normalization", () => {
  it("keeps pull request drafts distinct from open issues and trims the visible text", () => {
    expect(
      toGitHubResolvedReference(reference, {
        repository: {
          issueOrPullRequest: {
            __typename: "PullRequest",
            title: " WIP ",
            url: " https://github.com/acme/web/pull/7 ",
            pullRequestState: "OPEN",
            isDraft: true,
          },
        },
      }),
    ).toMatchObject({ title: "WIP", state: "draft", kind: "pull-request" });
    expect(
      toGitHubResolvedReference(reference, {
        repository: {
          issueOrPullRequest: { __typename: "Issue", title: "Bug", url: "u", state: "CLOSED" },
        },
      }),
    ).toMatchObject({ kind: "issue", state: "closed" });
  });
  it("leaves unexplained nulls unknown and preserves explicit missing answers", () => {
    expect(toGitHubResolvedReference(reference, { repository: null })).toBeNull();
    expect(missingGitHubReference(reference)).toEqual({
      ...reference,
      title: null,
      url: null,
      state: null,
      kind: null,
    });
  });
  it("rejects malformed repository selectors", () => {
    expect(splitRepository("owner/repo/extra")).toBeNull();
    expect(splitRepository("owner")).toBeNull();
    expect(splitRepository("owner/repo")).toEqual({ owner: "owner", name: "repo" });
  });
});
