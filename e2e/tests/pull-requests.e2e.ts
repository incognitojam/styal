import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { type App, openApp } from "../support/browser.ts";
import { type Environment, startEnvironment } from "../support/environment.ts";
import type { FakeGitHubPullRequest } from "../support/fake-github-api.ts";

describe("fork pull request workflows", () => {
  let environment: Environment;
  let app: App;
  const waiting: FakeGitHubPullRequest = {
    number: 42,
    title: "Add account settings",
    headSha: "a".repeat(40),
    blocked: true,
    requiredChecks: ["build", "integration"],
    checks: [
      { name: "build", required: true },
      { name: "docs", required: false },
    ],
  };
  const ready: FakeGitHubPullRequest = {
    number: 43,
    title: "Fix sidebar navigation",
    headSha: "b".repeat(40),
    checks: [
      { name: "build", required: true },
      { name: "integration", required: true },
    ],
  };

  beforeAll(async () => {
    environment = await startEnvironment({ pullRequests: [waiting, ready] });
    app = await openApp(environment);
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await environment?.stop();
    }
  });

  it("restores a numeric URL search and accepts a pasted pull request URL", async () => {
    // pull-request-number-search-url
    const { page } = app;
    await page.goto(`${environment.origin}/pull-requests?q=42`);
    const search = page.getByRole("searchbox", { name: "Search pull requests", exact: true });
    await page.getByRole("button", { name: /Add account settings/ }).waitFor();
    expect(await search.inputValue()).toBe("42");
    expect(await page.getByRole("button", { name: /Fix sidebar navigation/ }).count()).toBe(0);
    expect(
      environment
        .gitHubApiRequests()
        .some(
          (request) =>
            request.query?.includes("search(query:") && /\b42\b/.test(String(request.variables?.q)),
        ),
    ).toBe(true);

    const url = "https://github.com/e2e-org/demo-app/pull/43";
    await search.fill(url);
    await page.getByRole("button", { name: /Fix sidebar navigation/ }).waitFor();
    await expect
      .poll(() =>
        environment
          .gitHubApiRequests()
          .some(
            (request) =>
              request.query?.includes("search(query:") &&
              /\b43\b/.test(String(request.variables?.q)),
          ),
      )
      .toBe(true);
    expect(await search.inputValue()).toBe(url);
    expect(await page.getByRole("button", { name: /Add account settings/ }).count()).toBe(0);
  });

  it("distinguishes required, optional and not-yet-reported checks", async () => {
    // pull-request-required-checks
    const { page } = app;
    await page.goto(`${environment.origin}/pull-requests?q=42`);
    await page.getByRole("button", { name: /Add account settings/ }).click();
    await page.getByRole("button", { name: "Checks", exact: true }).click();
    const rows = page.getByRole("listitem");
    const build = rows.filter({ hasText: "build" });
    await build.getByText("Required", { exact: true }).waitFor();
    await build.getByText("Passed", { exact: true }).waitFor();
    const integration = rows.filter({ hasText: "integration" });
    await integration.getByText("Required", { exact: true }).waitFor();
    await integration.getByText("Waiting to be reported", { exact: true }).waitFor();
    const optional = rows.filter({ hasText: "docs" });
    await optional.getByText("Passed", { exact: true }).waitFor();
    expect(await optional.getByText("Required", { exact: true }).count()).toBe(0);
    expect(await integration.getByRole("button").count()).toBe(0);
    await page.getByText("Merge blocked", { exact: true }).first().waitFor();
    expect(
      environment
        .gitHubApiRequests()
        .some(
          (request) => request.query?.includes("isRequired") && request.variables?.number === 42,
        ),
    ).toBe(true);
    expect(
      environment
        .gitHubApiRequests()
        .some(
          (request) =>
            request.query?.includes("branchProtectionRule") &&
            request.variables?.qualifiedName === "refs/heads/main",
        ),
    ).toBe(true);
  });

  it("refuses a stale head, refreshes it, and pins the retried merge to the new commit", async () => {
    // pull-request-merge-head-guard
    const { page } = app;
    await page.goto(`${environment.origin}/pull-requests?q=43`);
    await page.getByRole("button", { name: /Fix sidebar navigation/ }).click();
    const merge = page.getByRole("button", { name: "Merge", exact: true });
    await merge.waitFor();
    ready.headSha = "c".repeat(40);
    await merge.click();
    await page.getByRole("button", { name: "Confirm merge?", exact: true }).click();
    await page.getByText(/New commits were pushed to #43/).waitFor();
    expect(
      environment
        .gitHubApiRequests()
        .filter((request) => request.query?.includes("mergePullRequest(input:")),
    ).toHaveLength(0);

    await merge.click();
    await page.getByRole("button", { name: "Confirm merge?", exact: true }).click();
    await page.getByText("Merged", { exact: true }).first().waitFor();
    const mutations = environment
      .gitHubApiRequests()
      .filter((request) => request.query?.includes("mergePullRequest(input:"));
    expect(mutations).toHaveLength(1);
    expect(mutations[0]!.variables?.input).toMatchObject({
      pullRequestId: "PR_43",
      expectedHeadOid: ready.headSha,
    });
  });
});
