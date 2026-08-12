import type { PullRequestCheck } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { parseGitHubActionsJobUrl, resolvePullRequestCheckOpenPlan } from "./openPullRequestCheck";

const check = (overrides: Partial<PullRequestCheck> = {}): PullRequestCheck => ({
  name: "Test",
  status: "failure",
  description: null,
  url: "https://github.com/acme/widgets/actions/runs/12/job/34",
  ...overrides,
});

describe("pull request check opening", () => {
  it("extracts a safe GitHub Actions run and job target", () => {
    expect(parseGitHubActionsJobUrl(check().url!)).toEqual({
      hostname: "github.com",
      repository: "acme/widgets",
      repositoryRef: "acme/widgets",
      runId: "12",
      jobId: "34",
    });
    expect(
      parseGitHubActionsJobUrl(
        "https://github.example.com/acme/widgets/actions/runs/12/job/34?attempt=2",
      ),
    ).toEqual({
      hostname: "github.example.com",
      repository: "acme/widgets",
      repositoryRef: "github.example.com/acme/widgets",
      runId: "12",
      jobId: "34",
    });
  });

  it("rejects URLs whose command tokens are not strictly safe", () => {
    expect(
      parseGitHubActionsJobUrl("https://github.com/acme/widgets/actions/runs/12/job/not-a-job"),
    ).toBeNull();
    expect(
      parseGitHubActionsJobUrl("https://github.com/acme/widgets/actions/runs/12/jobs/34"),
    ).toBeNull();
    expect(parseGitHubActionsJobUrl("https://example.com/acme/widgets/checks/12")).toBeNull();
  });

  it("opens a completed job's raw log immediately", () => {
    expect(resolvePullRequestCheckOpenPlan("github", check())).toEqual({
      kind: "terminal",
      command: "gh api --allow-escape-sequences repos/acme/widgets/actions/jobs/34/logs",
      presentation: {
        kind: "github-actions-log",
        title: "Test",
        command: "gh api --allow-escape-sequences repos/acme/widgets/actions/jobs/34/logs",
      },
    });
  });

  it("watches a pending run before downloading the selected job's raw log", () => {
    expect(resolvePullRequestCheckOpenPlan("github", check({ status: "pending" }))).toEqual({
      kind: "terminal",
      command:
        "gh run watch 12 --compact -R acme/widgets; gh api --allow-escape-sequences repos/acme/widgets/actions/jobs/34/logs",
      presentation: {
        kind: "github-actions-log",
        title: "Test",
        command:
          "gh run watch 12 --compact -R acme/widgets; gh api --allow-escape-sequences repos/acme/widgets/actions/jobs/34/logs",
      },
    });
  });

  it("targets the originating GitHub Enterprise host", () => {
    expect(
      resolvePullRequestCheckOpenPlan(
        "github",
        check({
          url: "https://github.example.com/acme/widgets/actions/runs/12/job/34",
        }),
      ),
    ).toEqual({
      kind: "terminal",
      command:
        "gh api --allow-escape-sequences --hostname github.example.com repos/acme/widgets/actions/jobs/34/logs",
      presentation: {
        kind: "github-actions-log",
        title: "Test",
        command:
          "gh api --allow-escape-sequences --hostname github.example.com repos/acme/widgets/actions/jobs/34/logs",
      },
    });
  });

  it("leaves non-Actions and non-GitHub checks to their external pages", () => {
    const githubAppCheck = check({
      url: "https://github.com/acme/widgets/pull/9/checks?check_run_id=34",
    });
    expect(resolvePullRequestCheckOpenPlan("github", githubAppCheck)).toEqual({
      kind: "external",
      url: githubAppCheck.url,
    });

    const pipeline = check({ url: "https://gitlab.com/acme/widgets/-/pipelines/12" });
    expect(resolvePullRequestCheckOpenPlan("gitlab", pipeline)).toEqual({
      kind: "external",
      url: pipeline.url,
    });
  });
});
