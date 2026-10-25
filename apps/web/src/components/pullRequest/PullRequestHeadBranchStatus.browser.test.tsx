import {
  EnvironmentId,
  SourceControlProviderKind,
  type PullRequestDetail,
} from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const { report } = vi.hoisted(() => ({ report: vi.fn() }));
vi.mock("~/forkClientUsage", () => ({ reportForkClientUsage: report }));
import { PullRequestHeadBranchStatus } from "./PullRequestHeadBranchStatus";

it("updates branch status after refresh and counts each visible state once", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  report.mockClear();
  const environmentId = EnvironmentId.make("synthetic-branch-status-environment");
  const render = async (headBranchState: PullRequestDetail["headBranchState"]) =>
    act(async () => {
      root.render(
        <PullRequestHeadBranchStatus
          environmentId={environmentId}
          detail={{
            provider: SourceControlProviderKind.make("github"),
            url: "https://github.com/acme/web/pull/7",
            ...(headBranchState === undefined ? {} : { headBranchState }),
          }}
        />,
      );
    });
  try {
    await render("present");
    expect(container.textContent).toContain("Branch exists");
    await render("deleted");
    expect(container.textContent).toContain("Branch deleted");
    expect(container.textContent).not.toContain("Branch exists");
    await render("present");
    expect(container.textContent).toContain("Branch exists");
    expect(report).toHaveBeenCalledTimes(2);
    await render(undefined);
    expect(container.textContent).toContain("Unknown");
    expect(container.textContent).not.toContain("Branch deleted");
    await render("unknown");
    expect(report).toHaveBeenCalledTimes(3);
    expect(report).toHaveBeenLastCalledWith(environmentId, {
      feature: "pull-request-branch-status",
      action: "status_shown",
      branchState: "unknown",
    });
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
