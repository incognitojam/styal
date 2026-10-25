import "~/index.css";
import {
  EnvironmentId,
  ProjectId,
  SourceControlProviderKind,
  type PullRequestDetailView,
} from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const { openLink, report } = vi.hoisted(() => ({ openLink: vi.fn(), report: vi.fn() }));
vi.mock("~/browser/useOpenLink", () => ({ useOpenLink: () => openLink }));
vi.mock("~/forkClientUsage", () => ({ reportForkClientUsage: report }));

import { PullRequestTimelineTab } from "./PullRequestTimelineTab";

const actor = { login: "maintainer", name: null, avatarUrl: null };
const commitUrl = "https://github.com/acme/web/commit/1234567890abcdef";
const detail: PullRequestDetailView = {
  provider: SourceControlProviderKind.make("github"),
  projectId: ProjectId.make("project"),
  projectTitle: "Project",
  workspaceRoot: "/workspace",
  repository: "acme/web",
  number: 7,
  title: "A change",
  body: "",
  url: "https://github.com/acme/web/pull/7",
  author: null,
  state: "merged",
  isDraft: false,
  mergeability: "unknown",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  headBranch: "feature",
  baseBranch: "main",
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T12:00:00Z",
  mergedAt: "2026-10-01T12:00:00Z",
  closedAt: "2026-10-01T12:00:00Z",
  reviewers: [],
  labels: [],
  checks: [],
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
  },
  viewerPermissions: {
    actions: [],
    comment: false,
    resolve: false,
    verdicts: [],
    requestReviewers: false,
  },
  lifecycleEvents: [
    {
      id: "ME_1",
      kind: "merged",
      createdAt: "2026-10-01T12:00:00Z",
      actor,
      targetBranch: "release",
      commit: { oid: "1234567890abcdef", url: commitUrl },
    },
    {
      id: "HDE_1",
      kind: "head-ref-deleted",
      createdAt: "2026-10-01T12:01:00Z",
      actor,
      branchName: "feature",
    },
    {
      id: "HRE_1",
      kind: "head-ref-restored",
      createdAt: "2026-10-01T12:02:00Z",
      actor: null,
      branchName: null,
    },
  ],
  lifecycleEventsTruncated: true,
};

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  openLink.mockResolvedValue(undefined);
  container = document.createElement("div");
  container.style.position = "fixed";
  container.style.inset = "0";
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const render = (value = detail, order: "newest" | "oldest" = "newest") =>
  act(async () =>
    root.render(
      <PullRequestTimelineTab
        scrollerRef={() => {}}
        detail={value}
        reference={value}
        environmentId={EnvironmentId.make("environment")}
        order={order}
        onOpenCommit={vi.fn()}
        onRefresh={vi.fn()}
      />,
    ),
  );

it("opens the host-reported merge commit and preserves factual history in both orders", async () => {
  await render();
  expect(container.textContent ?? "").toContain("merged commit 1234567 into release");
  expect(container.textContent ?? "").toContain("deleted the feature branch");
  expect(container.textContent ?? "").toContain("restored the branch");
  expect(container.textContent ?? "").toContain("More activity is available on the provider.");
  expect(container.textContent ?? "").not.toContain("Pull request merged");
  expect((container.textContent ?? "").indexOf("restored")).toBeLessThan(
    (container.textContent ?? "").indexOf("deleted"),
  );
  expect(report).not.toHaveBeenCalled();
  await act(async () => userEvent.click(container.querySelector("button")!));
  expect(openLink).toHaveBeenCalledExactlyOnceWith(commitUrl);
  expect(report).toHaveBeenCalledExactlyOnceWith(EnvironmentId.make("environment"), {
    feature: "pull-request-lifecycle",
    action: "open_commit",
    outcome: "success",
  });
  await render(detail, "oldest");
  expect((container.textContent ?? "").indexOf("deleted")).toBeLessThan(
    (container.textContent ?? "").indexOf("restored"),
  );
  expect(report).toHaveBeenCalledTimes(1);
});

it("retains the legacy merge fallback without fabricating an actor or a commit link", async () => {
  await render({ ...detail, lifecycleEvents: undefined, lifecycleEventsTruncated: undefined });
  expect(container.textContent ?? "").toContain("Pull request merged");
  expect(container.textContent ?? "").not.toContain("maintainer");
  expect(container.textContent ?? "").not.toContain("deleted the");
  expect(container.querySelector("button")).toBeNull();
});

it("aligns the lifecycle marker with the primary text rather than its timestamp", async () => {
  await render();
  const icon = container.querySelector<SVGElement>("svg.lucide-trash-2")!;
  const row = icon.closest("div.relative")!;
  const primary = Array.from(row.querySelectorAll("span")).find(
    (element) => element.textContent === "deleted the feature branch",
  )!;
  primary.scrollIntoView();
  const iconRect = icon.getBoundingClientRect();
  const textRect = primary.getBoundingClientRect();
  expect(
    Math.abs(iconRect.top + iconRect.height / 2 - textRect.top - textRect.height / 2),
  ).toBeLessThanOrEqual(1);
});
