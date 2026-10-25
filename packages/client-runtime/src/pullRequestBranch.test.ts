import { SourceControlProviderKind } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { pullRequestHeadBranchStatus } from "./pullRequestBranch.ts";

it("shows verified source state without consulting delete permission or PR lifecycle", () => {
  const provider = SourceControlProviderKind.make("github");
  expect(pullRequestHeadBranchStatus({ provider, headBranchState: "present" })).toBe(
    "Branch exists",
  );
  expect(pullRequestHeadBranchStatus({ provider, headBranchState: "deleted" })).toBe(
    "Branch deleted",
  );
  expect(pullRequestHeadBranchStatus({ provider, headBranchState: "unknown" })).toBe("Unknown");
  expect(pullRequestHeadBranchStatus({ provider })).toBe("Unknown");
  expect(
    pullRequestHeadBranchStatus({ provider: SourceControlProviderKind.make("gitlab") }),
  ).toBeNull();
});
