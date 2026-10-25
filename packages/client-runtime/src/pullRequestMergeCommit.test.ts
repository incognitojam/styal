import { describe, expect, it } from "vite-plus/test";
import {
  SourceControlProviderKind,
  type PullRequestCheck,
  type PullRequestDetail,
} from "@t3tools/contracts";
import { mergedPullRequestCommit, mergeCommitChecksSummary } from "./pullRequestMergeCommit.ts";

const check = (status: PullRequestCheck["status"]): PullRequestCheck => ({
  name: "Deploy",
  status,
  description: null,
  url: null,
});
const commit = {
  oid: "b".repeat(40),
  url: `https://github.com/acme/web/commit/${"b".repeat(40)}`,
  checks: [check("failure")],
};
const pr = {
  state: "merged",
  provider: SourceControlProviderKind.make("github"),
  checks: [check("success")],
  mergeCommit: commit,
} satisfies Pick<PullRequestDetail, "state" | "provider" | "checks" | "mergeCommit">;

describe("merge commit checks", () => {
  it("keeps passing PR checks out of the resulting commit's failed rollup", () => {
    const selected = mergedPullRequestCommit(pr);
    expect(selected).toBe(commit);
    expect(mergeCommitChecksSummary(selected!)).toEqual({
      label: "1 check failed",
      state: "failing",
    });
  });
  it("only exposes a resulting commit after merging, including an unavailable GitHub result", () => {
    expect(mergedPullRequestCommit({ ...pr, state: "open" })).toBeUndefined();
    expect(mergedPullRequestCommit({ ...pr, state: "closed" })).toBeUndefined();
    expect(mergedPullRequestCommit({ ...pr, mergeCommit: undefined })).toBeNull();
    expect(
      mergedPullRequestCommit({
        ...pr,
        provider: SourceControlProviderKind.make("gitlab"),
        mergeCommit: undefined,
      }),
    ).toBeUndefined();
  });
  it("preserves missing commit, unreadable checks, no checks, pending, and terminal outcomes", () => {
    expect(mergeCommitChecksSummary(null)).toEqual({
      label: "Merge commit unavailable",
      state: null,
    });
    expect(mergeCommitChecksSummary({ ...commit, checks: null })).toEqual({
      label: "Checks unavailable",
      state: null,
    });
    expect(mergeCommitChecksSummary({ ...commit, checks: [] })).toEqual({
      label: "No checks reported",
      state: null,
    });
    expect(
      mergeCommitChecksSummary({ ...commit, checks: [check("success"), check("pending")] }),
    ).toEqual({ label: "1 check pending, 1 check passed", state: "pending" });
    expect(
      mergeCommitChecksSummary({ ...commit, checks: [check("success"), check("cancelled")] }),
    ).toEqual({ label: "1 check cancelled, 1 check passed", state: "failing" });
    expect(
      mergeCommitChecksSummary({ ...commit, checks: [check("skipped"), check("neutral")] }),
    ).toEqual({ label: "1 check skipped, 1 check neutral", state: null });
    expect(
      mergeCommitChecksSummary({ ...commit, checks: [check("success"), check("success")] }),
    ).toEqual({ label: "2 checks passed", state: "passing" });
  });
});
