import type { PullRequestCheck, PullRequestDetail } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { pullRequestCheckCounts, resolvePullRequestDetailChecks } from "./pullRequestChecks.ts";

const detail = (overrides: Partial<PullRequestDetail> = {}): PullRequestDetail =>
  ({ title: "Cache the title", state: "open", checks: [], ...overrides }) as PullRequestDetail;

describe("resolvePullRequestDetailChecks", () => {
  it("uses fresh checks for detail counts without replacing other PR fields", () => {
    const pending = (name: string): PullRequestCheck => ({
      name,
      status: "pending",
      url: null,
      description: null,
    });
    const original = detail({ checks: [pending("build"), pending("test")] });
    const checks = [pending("build"), { ...pending("test"), status: "success" as const }];
    expect(resolvePullRequestDetailChecks(original, { state: "closed", checks }, true)).toEqual({
      ...original,
      state: "closed",
      checks,
    });
    expect(resolvePullRequestDetailChecks(original, { state: "closed", checks }, false)).toBe(
      original,
    );
    expect(resolvePullRequestDetailChecks(original, null, true)).toBe(original);
    expect(resolvePullRequestDetailChecks(null, { state: "closed", checks }, true)).toBeNull();
  });

  it("keeps newer checks when an older cached detail arrives later", () => {
    const pending: PullRequestCheck = {
      name: "build",
      status: "pending",
      url: null,
      description: null,
    };
    const cached = detail({ observedAt: 1_000, checks: [pending] });
    const checks = {
      state: "open" as const,
      checks: [{ ...pending, status: "success" as const }],
      observedAt: 2_000,
    };
    const resolved = resolvePullRequestDetailChecks(cached, checks, false);
    expect(resolved?.checks).toEqual(checks.checks);
    expect(resolved?.observedAt).toBe(1_000);
    expect(
      resolvePullRequestDetailChecks(cached, { state: checks.state, checks: checks.checks }, true)
        ?.checks,
    ).toEqual(checks.checks);
    const refreshed = detail({ observedAt: 3_000, checks: [pending] });
    expect(resolvePullRequestDetailChecks(refreshed, checks, true)).toBe(refreshed);
  });

  it("keeps required checks and unreported required rows from detail when applying checks", () => {
    const check = (name: string, status: PullRequestCheck["status"]): PullRequestCheck => ({
      name,
      status,
      url: null,
      description: null,
    });
    const original = detail({
      checks: [
        { ...check("build", "pending"), required: true },
        check("docs", "pending"),
        { ...check("integration", "expected"), required: true },
        { ...check("lint", "expected"), required: true },
      ],
    });
    const fresh = [check("build", "success"), check("docs", "success"), check("lint", "pending")];
    expect(
      resolvePullRequestDetailChecks(original, { state: "open", checks: fresh }, true)?.checks,
    ).toEqual([
      { ...check("build", "success"), required: true },
      check("docs", "success"),
      { ...check("lint", "pending"), required: true },
      { ...check("integration", "expected"), required: true },
    ]);
  });

  it("keeps merged details settled while applying newer checks", () => {
    const merged = detail({ state: "merged", observedAt: 1_000 });
    const checks = [{ name: "build", status: "success" as const, url: null, description: null }];
    expect(
      resolvePullRequestDetailChecks(merged, { state: "open", observedAt: 2_000, checks }, true),
    ).toEqual({ ...merged, checks });
  });
});

describe("pullRequestCheckCounts", () => {
  it.each([
    [[], 0, 0, 0, false],
    [["success"], 1, 0, 1, true],
    [["success", "success", "success", "skipped", "neutral"], 3, 2, 3, true],
    [["skipped", "neutral"], 0, 2, 0, false],
    [["success", "failure", "skipped"], 1, 1, 2, false],
    [["success", "pending", "neutral"], 1, 1, 2, false],
    [["cancelled", "skipped"], 0, 1, 1, false],
    [["expected", "action-required", "skipped"], 0, 1, 2, false],
  ] as const)("counts %j", (statuses, passed, skipped, runnable, allPassed) => {
    const checks = statuses.map((status) => ({
      name: status,
      status,
      url: null,
      description: null,
    }));
    expect(pullRequestCheckCounts(checks)).toEqual({
      passed,
      skipped,
      runnable,
      allPassed,
      skippedSummary: skipped ? ` · ${skipped} skipped` : "",
    });
  });
});
