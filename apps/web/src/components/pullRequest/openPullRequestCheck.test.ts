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
      jobId: "34",
    });
    expect(
      parseGitHubActionsJobUrl(
        "https://github.example.com/acme/widgets/actions/runs/12/job/34?attempt=2",
      ),
    ).toEqual({
      hostname: "github.example.com",
      repository: "acme/widgets",
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

  it("checks the selected job before downloading its raw log", () => {
    const plan = resolvePullRequestCheckOpenPlan("github", check({ status: "pending" }));

    expect(plan?.kind).toBe("terminal");
    if (plan?.kind !== "terminal") return;
    expect(plan.command.startsWith("sh -c '")).toBe(true);
    expect(plan.command).toContain("(.steps // [])[]");
    expect(plan.command).toContain("f=$((f+1))");
    expect(plan.command).toContain('if [ "$st" = in_progress ];then sleep 10;else sleep 15;fi');
    expect(plan.command).toContain("&&sleep 2");
    expect(plan.command).toContain(
      "gh api --allow-escape-sequences repos/acme/widgets/actions/jobs/34/logs",
    );
    // The first command is entered through a canonical PTY, whose input buffer
    // truncates very long unsubmitted lines on macOS.
    expect(plan.command.length).toBeLessThan(900);
    expect(plan.presentation.command).toBe(plan.command);

    const completed = resolvePullRequestCheckOpenPlan("github", check());
    expect(completed?.kind === "terminal" ? completed.command : null).toBe(plan.command);
  });

  it("uses native PowerShell syntax on Windows", () => {
    const plan = resolvePullRequestCheckOpenPlan("github", check({ status: "pending" }), "windows");

    expect(plan?.kind).toBe("terminal");
    if (plan?.kind !== "terminal") return;
    expect(plan.command).toContain("$s = @(");
    expect(plan.command).toContain("$d = if ($st -eq 'in_progress') { 10 } else { 15 }");
    expect(plan.command).toContain("Start-Sleep -Seconds $d");
    expect(plan.command).toContain("Start-Sleep -Seconds 2");
    expect(plan.command).not.toContain("sh -c");
    expect(plan.command.length).toBeLessThan(900);
  });

  it("targets the originating GitHub Enterprise host", () => {
    const plan = resolvePullRequestCheckOpenPlan(
      "github",
      check({
        url: "https://github.example.com/acme/widgets/actions/runs/12/job/34",
      }),
    );

    expect(plan?.kind).toBe("terminal");
    if (plan?.kind !== "terminal") return;
    expect(plan.command).toContain(
      "gh api --hostname github.example.com repos/acme/widgets/actions/jobs/34",
    );
    expect(plan.command).toContain(
      "gh api --allow-escape-sequences --hostname github.example.com repos/acme/widgets/actions/jobs/34/logs",
    );
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
