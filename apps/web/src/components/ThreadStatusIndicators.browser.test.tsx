import { describe, expect, it } from "vite-plus/test";

import { render } from "../../test/render";
import { ThreadPullRequestsMiniList } from "./ThreadStatusIndicators";

describe("ThreadPullRequestsMiniList", () => {
  const branchPullRequest = {
    number: 579,
    title: "Fix the branch pull request",
    url: "https://github.com/acme/web/pull/579",
    baseRef: "main",
    headRef: "fix-branch",
    state: "open" as const,
  };

  it("lists the branch pull request when the thread has no linked pull requests", async () => {
    await using screen = await render(
      <ThreadPullRequestsMiniList pullRequests={[]} fallback={branchPullRequest} />,
    );
    expect(screen.container.textContent).toContain("#579");
    expect(screen.container.textContent).toContain("Fix the branch pull request");
  });

  it("lists linked pull requests instead of the branch pull request", async () => {
    await using screen = await render(
      <ThreadPullRequestsMiniList
        pullRequests={[
          {
            host: "github.com",
            repository: "acme/web",
            number: 42,
            url: "https://github.com/acme/web/pull/42",
            source: "manual",
            linkedAt: "2026-01-01T00:00:00Z",
            stack: null,
            snapshot: null,
          },
        ]}
        fallback={branchPullRequest}
      />,
    );
    expect(screen.container.textContent).toContain("#42");
    expect(screen.container.textContent).not.toContain("#579");
  });

  it("renders nothing without linked or branch pull requests", async () => {
    await using screen = await render(<ThreadPullRequestsMiniList pullRequests={[]} />);
    expect(screen.container.innerHTML).toBe("");
  });
});
