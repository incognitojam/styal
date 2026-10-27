import type { PullRequestDeployment } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  orderPullRequestDeployments,
  pullRequestDeploymentCommit,
  pullRequestDeploymentsTitle,
} from "./pullRequestDeployments.ts";

const deployment = (
  environment: string,
  status: PullRequestDeployment["status"],
): PullRequestDeployment => ({
  id: environment,
  environment,
  status,
  description: null,
  environmentUrl: null,
  logUrl: null,
  commitSha: "a".repeat(40),
  createdAt: "2026-07-01T00:00:00Z",
  updatedAt: "2026-07-01T00:00:00Z",
});

describe("orderPullRequestDeployments", () => {
  it("puts failures first and inactive last, keeping the host's order within a status", () => {
    const ordered = orderPullRequestDeployments([
      deployment("api", "inactive"),
      deployment("docs", "success"),
      deployment("preview", "queued"),
      deployment("storybook", "error"),
      deployment("web", "failure"),
      deployment("worker", "success"),
    ]);
    expect(ordered.map((entry) => entry.environment)).toEqual([
      "storybook",
      "web",
      "preview",
      "docs",
      "worker",
      "api",
    ]);
  });
});

describe("pullRequestDeploymentsTitle", () => {
  it("names failures in the heading before anything still deploying", () => {
    expect(
      pullRequestDeploymentsTitle([
        deployment("web", "failure"),
        deployment("docs", "in-progress"),
      ]),
    ).toBe("Deployments (2) · 1 failed");
    expect(
      pullRequestDeploymentsTitle([deployment("web", "pending"), deployment("docs", "success")]),
    ).toBe("Deployments (2) · 1 deploying");
    expect(pullRequestDeploymentsTitle([deployment("web", "success")])).toBe("Deployments (1)");
  });
});

describe("pullRequestDeploymentCommit", () => {
  const head = "a".repeat(40);
  const older = { ...deployment("web", "success"), commitSha: "b".repeat(40) };

  it("hides the commit when the deployment is of the PR head", () => {
    expect(pullRequestDeploymentCommit(deployment("web", "success"), head)).toBeNull();
  });

  it("marks a commit other than the head as older", () => {
    expect(pullRequestDeploymentCommit(older, head)).toEqual({
      sha: "b".repeat(40),
      shortSha: "bbbbbbb",
      older: true,
    });
  });

  it("shows the commit without calling it older when the head is unknown", () => {
    expect(pullRequestDeploymentCommit(older, undefined)).toMatchObject({
      shortSha: "bbbbbbb",
      older: false,
    });
  });
});
