import { ThreadId, type ThreadPullRequestLink } from "@t3tools/contracts";
import { act, cloneElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("./ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => (
    <span data-testid="pr-tooltip">{children}</span>
  ),
  TooltipTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(render, {}, children),
  TooltipPopup: () => null,
}));

import {
  ThreadPullRequestBadgeControl,
  ThreadWorktreeIndicator,
  linkedPullRequestSnapshotStatus,
} from "./ThreadStatusIndicators";

describe("ThreadPullRequestBadgeControl", () => {
  it("shows the current PR number followed by additional linked PRs", () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let renderer: ReactTestRenderer | undefined;
    act(() => {
      renderer = create(
        <ThreadPullRequestBadgeControl
          variant="underline"
          badge={{ kind: "pull-request", others: 1 }}
          number={102}
          url="https://github.com/example/project/pull/102"
          status={null}
          onOpenStack={() => {}}
          onOpenPullRequest={() => {}}
        />,
      );
    });
    const mounted = renderer;
    if (!mounted) throw new Error("Badge did not render");
    const link = mounted.root.findByType("a");
    expect(link.children).toContain("102+1");
    expect(link.props["aria-label"]).toBe("PR #102, status pending, and 1 more linked");
    expect(mounted.root.findAllByProps({ "data-testid": "pr-tooltip" })).toHaveLength(0);
    act(() => {
      mounted.update(
        <ThreadPullRequestBadgeControl
          variant="underline"
          badge={{ kind: "pull-request", others: 0 }}
          number={3}
          url="https://github.com/example/project/pull/3"
          status={null}
          onOpenStack={() => {}}
          onOpenPullRequest={() => {}}
        />,
      );
    });
    expect(mounted.root.findByType("a").children).toContain("3");
    expect(mounted.root.findByType("a").children).not.toContain("3+1");
    act(() => mounted.unmount());
  });

  it("keeps the composer PR tooltip", () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let renderer: ReactTestRenderer | undefined;
    act(() => {
      renderer = create(
        <ThreadPullRequestBadgeControl
          variant="ghost"
          badge={{ kind: "pull-request", others: 1 }}
          number={102}
          url="https://github.com/example/project/pull/102"
          status={null}
          onOpenStack={() => {}}
          onOpenPullRequest={() => {}}
        />,
      );
    });
    const mounted = renderer;
    if (!mounted) throw new Error("Badge did not render");
    expect(mounted.root.findAllByProps({ "data-testid": "pr-tooltip" })).toHaveLength(1);
    act(() => mounted.unmount());
  });
});

describe("ThreadWorktreeIndicator", () => {
  it("renders the worktree folder and branch in an accessible label", () => {
    const markup = renderToStaticMarkup(
      <ThreadWorktreeIndicator
        thread={{
          id: ThreadId.make("thread-1"),
          branch: "feature/sidebar-indicator",
          worktreePath: "/tmp/worktrees/sidebar-indicator",
        }}
      />,
    );

    expect(markup).toContain('role="img"');
    expect(markup).toContain(
      'aria-label="Worktree: sidebar-indicator (feature/sidebar-indicator)"',
    );
    expect(markup).toContain('data-testid="thread-worktree-thread-1"');
  });

  it.each([null, "", "   "])("renders nothing for an absent worktree path", (worktreePath) => {
    const markup = renderToStaticMarkup(
      <ThreadWorktreeIndicator
        thread={{
          id: ThreadId.make("thread-1"),
          branch: "main",
          worktreePath,
        }}
      />,
    );

    expect(markup).toBe("");
  });
});

describe("linked pull request snapshots", () => {
  const link: ThreadPullRequestLink = {
    host: "gitlab.example.com",
    repository: "acme/web",
    number: 42,
    url: "https://gitlab.example.com/acme/web/-/merge_requests/42",
    source: "manual",
    linkedAt: "2026-01-01T00:00:00Z",
    stack: null,
    snapshot: null,
  };
  it("keeps unsynced links unknown", () => {
    expect(linkedPullRequestSnapshotStatus(link)).toBeNull();
  });
  it("uses the snapshot state and branches with the linked identity", () => {
    const result = linkedPullRequestSnapshotStatus({
      ...link,
      snapshot: {
        state: "merged",
        title: "Change",
        headBranch: "feature",
        baseBranch: "main",
        isDraft: false,
        updatedAt: "2026-01-02T00:00:00Z",
        syncedAt: "2026-01-03T00:00:00Z",
      },
    });
    expect(result).toEqual({
      pr: {
        number: 42,
        url: link.url,
        title: "Change",
        state: "merged",
        isDraft: false,
        headRef: "feature",
        baseRef: "main",
        updatedAt: "2026-01-02T00:00:00Z",
      },
      sourceControlProvider: { kind: "gitlab", name: "gitlab", baseUrl: "" },
    });
  });
});
