import { EnvironmentId, type PullRequestMergeCommit } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const { openLink, report } = vi.hoisted(() => ({ openLink: vi.fn(), report: vi.fn() }));
vi.mock("~/browser/useOpenLink", () => ({ useOpenLink: () => openLink }));
vi.mock("~/forkClientUsage", () => ({ reportForkClientUsage: report }));

import { PullRequestMergeCommitChecks } from "./PullRequestMergeCommitChecks";

const environmentId = EnvironmentId.make("merge-checks-test");
const commit: PullRequestMergeCommit = {
  oid: "b".repeat(40),
  url: `https://github.com/acme/web/commit/${"b".repeat(40)}`,
  checks: [
    { name: "Deploy", status: "pending", description: null, url: "https://example.com/runs/1" },
  ],
};
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  openLink.mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const render = (value: PullRequestMergeCommit | null) =>
  act(async () =>
    root.render(<PullRequestMergeCommitChecks commit={value} environmentId={environmentId} />),
  );

it("opens the resulting commit and its own check details, and updates while expanded", async () => {
  await render(commit);
  expect(container.textContent).toContain("1 check pending");
  expect(container.textContent).not.toContain("Deploy");
  await act(async () => userEvent.click(container.querySelector("a")!));
  expect(openLink).toHaveBeenLastCalledWith(commit.url);
  await act(async () => userEvent.click(container.querySelector("button")!));
  expect(container.textContent).toContain("Deploy");
  const failed: PullRequestMergeCommit = {
    ...commit,
    checks: [{ ...commit.checks![0]!, status: "failure", description: "Deployment failed" }],
  };
  await render(failed);
  expect(container.textContent).toContain("1 check failed");
  expect(container.textContent).toContain("Deployment failed");
  expect(container.textContent).not.toContain("pending");
  await act(async () => userEvent.click(container.querySelectorAll("a")[1]!));
  expect(openLink).toHaveBeenLastCalledWith("https://example.com/runs/1");
  expect(report.mock.calls).toEqual([
    [
      environmentId,
      { feature: "pull-request-merge-commit-checks", action: "open_commit", outcome: "success" },
    ],
    [
      environmentId,
      { feature: "pull-request-merge-commit-checks", action: "open_check", outcome: "success" },
    ],
  ]);
  openLink.mockRejectedValueOnce(new Error("Unavailable"));
  await act(async () => userEvent.click(container.querySelectorAll("a")[1]!));
  expect(report).toHaveBeenLastCalledWith(environmentId, {
    feature: "pull-request-merge-commit-checks",
    action: "open_check",
    outcome: "failure",
  });
});

it("keeps commit links usable when checks are unavailable and updates when checks arrive", async () => {
  await render(null);
  expect(container.textContent).toContain("Merge commit unavailable");
  expect(container.querySelector("a")).toBeNull();
  await render({ ...commit, checks: null });
  expect(container.textContent).toContain("Checks unavailable");
  await act(async () => userEvent.click(container.querySelector("a")!));
  expect(openLink).toHaveBeenLastCalledWith(commit.url);
  await render({ ...commit, checks: [] });
  expect(container.textContent).toContain("No checks reported");
  await render(commit);
  await act(async () => userEvent.click(container.querySelector("button")!));
  expect(container.textContent).toContain("Deploy");
  expect(container.textContent).toContain("Running");
});
