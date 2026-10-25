import { EnvironmentId, type PullRequestMergeCommit } from "@t3tools/contracts";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const { openLink, report, openSourceCheck } = vi.hoisted(() => ({
  openLink: vi.fn(),
  report: vi.fn(),
  openSourceCheck: vi.fn(),
}));
vi.mock("~/browser/useOpenLink", () => ({ useOpenLink: () => openLink }));
vi.mock("~/forkClientUsage", () => ({ reportForkClientUsage: report }));
import { PullRequestChecksTab } from "./PullRequestChecksTab";
import {
  PullRequestMergeCommitChecks,
  type PullRequestChecksScope,
} from "./PullRequestMergeCommitChecks";

const environmentId = EnvironmentId.make("merge-checks-test");
const commit: PullRequestMergeCommit = {
  oid: "b".repeat(40),
  url: `https://github.com/acme/web/commit/${"b".repeat(40)}`,
  checks: [
    { name: "Deploy", status: "pending", description: null, url: "https://example.com/runs/1" },
  ],
};
function Harness({ value }: { value: PullRequestMergeCommit | null | undefined }) {
  const [scope, setScope] = useState<PullRequestChecksScope>("merge-commit");
  return (
    <PullRequestMergeCommitChecks
      commit={value}
      headSha={"a".repeat(40)}
      environmentId={environmentId}
      scope={scope}
      onScopeChange={setScope}
    >
      <PullRequestChecksTab
        checks={[
          {
            name: "Source tests",
            status: "success",
            description: null,
            url: "https://example.com/source",
          },
        ]}
        onOpenCheck={openSourceCheck}
      />
    </PullRequestMergeCommitChecks>
  );
}
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
const render = (value: PullRequestMergeCommit | null | undefined) =>
  act(async () => root.render(<Harness value={value} />));
const scopeButton = (label: string) =>
  Array.from(container.querySelectorAll("button")).find((button) => button.textContent === label)!;
const checkButton = (name: string) =>
  container.querySelector(`[aria-label="Open ${name} on the host"]`)!;

it("switches scopes without mixing their check rows, SHAs or links", async () => {
  await render(commit);
  expect(container.textContent).toContain("Deploy");
  expect(container.textContent).toContain("bbbbbbb");
  expect(container.textContent).not.toContain("Source tests");
  await act(async () => userEvent.click(container.querySelector("a")!));
  expect(openLink).toHaveBeenLastCalledWith(commit.url);
  await act(async () => userEvent.click(scopeButton("Pull request")));
  expect(container.textContent).toContain("Source tests");
  expect(container.textContent).toContain("aaaaaaa");
  expect(container.textContent).not.toContain("Deploy");
  await act(async () => userEvent.click(checkButton("Source tests")));
  expect(openSourceCheck).toHaveBeenCalledExactlyOnceWith("https://example.com/source");
  expect(report).toHaveBeenCalledTimes(1);
  await act(async () => userEvent.click(scopeButton("Merge commit")));
  await render({
    ...commit,
    checks: [{ ...commit.checks![0]!, status: "failure", description: "Deployment failed" }],
  });
  expect(container.textContent).toContain("Failed");
  expect(container.textContent).not.toContain("Running");
  await act(async () => userEvent.click(checkButton("Deploy")));
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
  await act(async () => userEvent.click(checkButton("Deploy")));
  expect(report).toHaveBeenLastCalledWith(environmentId, {
    feature: "pull-request-merge-commit-checks",
    action: "open_check",
    outcome: "failure",
  });
});

it("keeps unavailable and empty merge results distinct while retaining source checks and commit links", async () => {
  await render(null);
  expect(container.textContent).toContain("Merge commit unavailable");
  expect(container.querySelector("a")).toBeNull();
  await act(async () => userEvent.click(scopeButton("Pull request")));
  expect(container.textContent).toContain("Source tests");
  await act(async () => userEvent.click(scopeButton("Merge commit")));
  await render({ ...commit, checks: null });
  expect(container.textContent).toContain("Checks unavailable");
  expect(container.textContent).not.toContain("No checks reported");
  await act(async () => userEvent.click(container.querySelector("a")!));
  expect(openLink).toHaveBeenLastCalledWith(commit.url);
  await render({ ...commit, checks: [] });
  expect(container.textContent).toContain("No checks reported");
  await render(commit);
  expect(container.textContent).toContain("Deploy");
  expect(container.textContent).toContain("Running");
});

it("preserves ordinary pull request checks when merge commit data is unsupported", async () => {
  await render(undefined);
  expect(container.textContent).toContain("Source tests");
  expect(container.textContent).not.toContain("Merge commit");
  expect(container.querySelector("a")).toBeNull();
});
