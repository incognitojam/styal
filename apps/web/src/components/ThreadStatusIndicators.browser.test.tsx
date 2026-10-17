import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ThreadPullRequestsMiniList } from "./ThreadStatusIndicators";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(element: ReactNode) {
  await act(() => root.render(element));
}

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
    await render(<ThreadPullRequestsMiniList pullRequests={[]} fallback={branchPullRequest} />);
    expect(container.textContent).toContain("#579");
    expect(container.textContent).toContain("Fix the branch pull request");
  });

  it("lists linked pull requests instead of the branch pull request", async () => {
    await render(
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
    expect(container.textContent).toContain("#42");
    expect(container.textContent).not.toContain("#579");
  });

  it("renders nothing without linked or branch pull requests", async () => {
    await render(<ThreadPullRequestsMiniList pullRequests={[]} />);
    expect(container.innerHTML).toBe("");
  });
});
