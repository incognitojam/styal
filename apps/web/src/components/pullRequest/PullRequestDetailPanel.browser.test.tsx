import {
  EnvironmentId,
  ProjectId,
  SourceControlProviderKind,
  ThreadId,
  type PullRequestDetailView,
  type PullRequestSummary,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { useRightPanelStore } from "~/rightPanelStore";

import "~/index.css";
import { render as renderUi } from "../../../test/render";

const {
  newThread,
  prepareThread,
  refresh,
  update,
  addToast,
  updateToast,
  checkoutState,
  sharedSummary,
  hostCommand,
  queries,
} = vi.hoisted(() => ({
  sharedSummary: vi.fn<() => PullRequestSummary | null>(),
  hostCommand: vi.fn(),
  queries: { diff: undefined as unknown },
  newThread: vi.fn(),
  prepareThread: vi.fn(),
  refresh: vi.fn(),
  update: vi.fn(),
  addToast: vi.fn(),
  updateToast: vi.fn(),
  checkoutState: { error: null as Error | null },
}));

vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock(import("~/hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: (() => undefined) as never,
}));
vi.mock(import("~/hooks/useHandleNewThread"), async (original) => ({
  ...(await original()),
  useNewThreadHandler: (() => newThread) as never,
}));
vi.mock(import("~/lib/sourceControlActions"), async (original) => ({
  ...(await original()),
  usePreparePullRequestThreadAction: (() => ({
    run: prepareThread,
    isAllowed: true,
    error: checkoutState.error,
  })) as never,
}));
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) =>
    command === "update" ? update : command === "invalidate" ? refresh : hostCommand) as never,
}));
vi.mock(import("~/state/pullRequests"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const cannotWriteGuides = Atom.make(false);
  const diff = Atom.make(null);
  queries.diff = diff;
  return {
    ...actual,
    useSharedPullRequestSummary: sharedSummary,
    pullRequestEnvironment: {
      ...actual.pullRequestEnvironment,
      detail: (() => "detail") as never,
      diff: (() => diff) as never,
      activity: (() => "activity") as never,
      update: "update" as never,
      invalidate: "invalidate" as never,
      reviewGuide: (() => "review-guide") as never,
      generateReviewGuide: {
        ...actual.pullRequestEnvironment.generateReviewGuide,
        permissionAtom: () => cannotWriteGuides,
      },
    },
  };
});
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((query: unknown) => ({
    data:
      query === "detail"
        ? (activityDetail ?? liveDetail)
        : query === "activity"
          ? activityDetail
          : query === queries.diff
            ? diff
            : null,
    dataUpdatedAt: query === "detail" ? liveDetail.observedAt : 0,

    failure: null,
    isPending: false,
    isSuccess: true,
    error: null,
    refresh,
  })) as never,
}));
vi.mock(import("~/state/usePullRequestStack"), async (original) => ({
  ...(await original()),
  usePullRequestStack: (() => ({
    data: null,
    isSuccess: true,
    isPending: false,
    error: null,
    refresh,
  })) as never,
}));
// Action and scroll tests use stand-ins; activity tests render the real Summary.
vi.mock(import("./PullRequestSummaryTab"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    PullRequestSummaryTab: ((props: ComponentProps<typeof actual.PullRequestSummaryTab>) => {
      if (activityDetail !== null) return <actual.PullRequestSummaryTab {...props} />;
      const { onFixFinding, scrollerRef } = props;
      return (
        <div ref={scrollerRef} data-testid="summary-scroller" className="h-full overflow-y-auto">
          <button
            type="button"
            onClick={() =>
              onFixFinding?.({
                kind: "check",
                check: {
                  name: "Unit tests",
                  status: "failure",
                  description: "Test failed",
                  url: null,
                },
              })
            }
          >
            Fix check
          </button>
          <div data-testid="nested-scroller" className="h-40 overflow-y-auto">
            <div className="h-[2000px]" />
          </div>
          <div className="h-[3000px]" />
        </div>
      );
    }) as never,
  };
});
// The Code tab waits for the diff worker pool, and a cold pool starts real Shiki workers that
// a loaded runner can keep past Pierre's 10s startup limit. These tests are about the panel,
// so the pool falls back to main-thread highlighting at once.
vi.mock("@pierre/diffs/worker/worker.js?worker", () => ({
  default: function UnavailableDiffsWorker() {
    throw new Error("Diff workers are disabled in panel tests");
  },
}));
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    toastManager: { ...actual.toastManager, add: addToast, update: updateToast } as never,
  };
});

import { PullRequestDetailPanel } from "./PullRequestDetailPanel";
import { usePullRequestReviewStore } from "./pullRequestReviewStore";

const detail: PullRequestDetailView = {
  provider: SourceControlProviderKind.make("github"),
  projectId: ProjectId.make("project"),
  projectTitle: "Project",
  workspaceRoot: "/workspace",
  repository: "owner/repo",
  number: 1,
  title: "Test pull request",
  body: "Original description",
  url: "https://github.com/owner/repo/pull/1",
  author: { login: "author", name: null, avatarUrl: null },
  viewer: "author",
  state: "open",
  isDraft: false,
  mergeability: "conflicting",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  headBranch: "feature",
  baseBranch: "main",
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  mergedAt: null,
  closedAt: null,
  reviewers: [],
  labels: [],
  checks: [{ name: "Unit tests", status: "success", description: null, url: null }],
  comments: [],
  commentCount: 0,
  commentsTruncated: false,
  reviewThreads: [],
  commits: [],
  mergeCapabilities: { merge: false, squash: false, rebase: false },
  capabilities: {
    diff: true,
    comment: false,
    search: true,
    actions: [],
    mergeMethods: [],
    review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
    reviewers: { request: false, listCandidates: false },
    edit: { changeRequest: true, comment: false },
  },
  viewerPermissions: {
    actions: [],
    comment: false,
    resolve: false,
    verdicts: [],
    requestReviewers: false,
  },
};

let liveDetail = detail;
let activityDetail: PullRequestDetailView | null = null;

// Enough lines to exercise the panel's title folding with the real virtualized Code tab.
const diff = {
  patch: [
    "diff --git a/a.ts b/a.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/a.ts",
    "@@ -0,0 +1,100 @@",
    "+broken()",
    ...Array.from({ length: 99 }, (_, index) => `+// line ${index + 2}`),
    "",
  ].join("\n"),
  truncated: false,
  nextCursor: null,
};

const threadRef: ScopedThreadRef = {
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-1"),
};
const newDraftId = DraftId.make("new-draft");
const shortcutContext = () => ({
  terminalFocus: false,
  terminalOpen: false,
  rightPanelFocus: false,
  previewFocus: false,
  previewOpen: false,
  isWeb: true,
  isDesktop: false,
});

function panelContainer() {
  const container = document.createElement("div");
  container.className = "flex h-[700px] w-[900px]";
  return container;
}

function render(props: Partial<ComponentProps<typeof PullRequestDetailPanel>> = {}) {
  return renderUi(
    <PullRequestDetailPanel
      environmentId={threadRef.environmentId}
      reference={detail}
      context="page"
      shortcutsEnabled={false}
      getShortcutContext={shortcutContext}
      {...props}
    />,
    { container: panelContainer() },
  );
}

// The mocked modules and stores are shared by the whole file, so every test starts by
// resetting them.
function setup() {
  activityDetail = null;
  liveDetail = detail;
  sharedSummary.mockReset().mockReturnValue(null);
  refresh.mockReset();
  useComposerDraftStore.setState({ draftsByThreadKey: {} });
  useRightPanelStore.setState({ byThreadKey: {} });
  usePullRequestReviewStore.setState({ drafts: {}, summaries: {} });
  hostCommand.mockReset();
  newThread
    .mockReset()
    .mockResolvedValue({ draftId: newDraftId, threadId: ThreadId.make("new-thread") });
  addToast.mockReset().mockReturnValue("checkout-toast");
  updateToast.mockReset();
  checkoutState.error = null;
  prepareThread.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { branch: "feature", worktreePath: "/workspace/pr" },
  });
  update.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
}

describe("checks contradicted by a newer cached summary", () => {
  it.each([
    ["success", "failing", "Some checks were not successful", "failure"],
    ["failure", "passing", "All checks have passed", "success"],
    ["success", "pending", "Some checks are still pending", "pending"],
    ["success", null, "No checks reported", null],
  ] as const)(
    "%s runs are hidden while the cached summary reports %s, until refresh",
    async (oldStatus, checksState, label, refreshedStatus) => {
      setup();
      liveDetail = {
        ...detail,
        observedAt: 100,
        mergeReadiness: "ready",
        checks: [{ name: "Cached unit tests", status: oldStatus, description: null, url: null }],
      };
      // The list's newer read time wins even when the host's updatedAt has not changed.
      const cachedEntry = {
        ...detail,
        environmentId: threadRef.environmentId,
        host: "github.com",
        observedAt: 200,
        viewerReviewRequested: false,
        ...(checksState === null ? {} : { checksState }),
      };
      // A shared summary can explicitly clear a rollup; list entries only report non-null ones.
      if (checksState === null) {
        sharedSummary.mockReturnValue({ ...detail, observedAt: 200, checksState: null });
      }
      const panel = (
        <PullRequestDetailPanel
          environmentId={threadRef.environmentId}
          reference={detail}
          listEntry={checksState === null ? null : cachedEntry}
          shortcutsEnabled={false}
          getShortcutContext={() => ({
            terminalFocus: false,
            terminalOpen: false,
            rightPanelFocus: false,
            previewFocus: false,
            previewOpen: false,
            isWeb: true,
            isDesktop: false,
          })}
        />
      );
      await using screen = await render(panel.props);
      const navButton = page
        .getByRole("button", { name: `Open checks: ${label}`, exact: true })
        .element();
      // A stale rollup has a label, but cannot support counts or the old merge verdict.
      expect(navButton.textContent).toBe(label);
      await page.getByRole("button", { name: `Open checks: ${label}`, exact: true }).click();
      expect(document.body.textContent ?? "").toContain("Check details are out of date.");
      expect(document.body.textContent ?? "").not.toContain("Cached unit tests");
      expect(document.body.textContent ?? "").not.toContain("Ready to merge");
      expect(page.getByRole("button", { name: "Fix", exact: true }).elements().length > 0).toBe(
        false,
      );

      refresh.mockImplementation(() => {
        liveDetail = {
          ...liveDetail,
          observedAt: 300,
          checks:
            refreshedStatus === null
              ? []
              : [
                  {
                    name: "Refreshed unit tests",
                    status: refreshedStatus,
                    description: null,
                    url: null,
                  },
                ],
        };
        sharedSummary.mockReturnValue(null);
      });
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      expect(refresh).toHaveBeenCalled();
      await screen.rerender(<PullRequestDetailPanel {...panel.props} />);
      expect(document.body.textContent ?? "").not.toContain("Check details are out of date.");
      if (refreshedStatus === null)
        expect(document.body.textContent ?? "").toContain("No checks reported");
      else {
        expect(document.body.textContent ?? "").toContain("Refreshed unit tests");
        expect(document.body.textContent ?? "").toContain(
          refreshedStatus === "failure"
            ? "1 of 1 failing"
            : refreshedStatus === "pending"
              ? "1 of 1 running"
              : "All checks passed",
        );
      }
      await page.getByRole("button", { name: "Summary", exact: true }).click();
      const refreshedNavButton = page.getByRole("button", { name: /^Open checks:/ }).element();
      expect(refreshedNavButton.textContent).toContain("Ready to merge");
      expect(refreshedNavButton.textContent).not.toBe(label);
    },
  );
});
