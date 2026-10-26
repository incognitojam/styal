import { describe, expect, it } from "vite-plus/test";

import {
  resolvePullRequestMergeNow,
  resolvePullRequestPrimaryControl,
} from "./pullRequestMergeControl.ts";

describe("pull request primary control", () => {
  const open = {
    state: "open" as const,
    isDraft: false,
    mergeability: "mergeable" as const,
    checksState: "passing" as const,
    mergeReadiness: "ready" as const,
    autoMergeEnabled: false,
    hasMergeMethod: true,
    canMerge: true,
    canMarkReady: true,
    canEnableAutoMerge: true,
  };

  it("moves repository policy blockers to auto-merge while leaving check health as context", () => {
    expect(resolvePullRequestPrimaryControl({ ...open, mergeReadiness: "blocked" })).toBe(
      "enable-auto-merge",
    );
    expect(resolvePullRequestPrimaryControl({ ...open, checksState: "failing" })).toBe("merge");
  });

  it("shows auto-merge for pending requirements when GitHub permits it", () => {
    const waiting = {
      ...open,
      checksState: "pending" as const,
      mergeReadiness: "blocked" as const,
    };
    expect(resolvePullRequestPrimaryControl(waiting)).toBe("enable-auto-merge");
    expect(resolvePullRequestPrimaryControl({ ...waiting, canEnableAutoMerge: false })).toBeNull();
  });

  it("moves pending and failing checks to auto-merge where the host reports no merge readiness", () => {
    const withoutReadiness = { ...open, mergeReadiness: undefined };
    expect(resolvePullRequestPrimaryControl({ ...withoutReadiness, checksState: "pending" })).toBe(
      "enable-auto-merge",
    );
    expect(resolvePullRequestPrimaryControl({ ...withoutReadiness, checksState: "failing" })).toBe(
      "enable-auto-merge",
    );
  });

  it("moves pending checks to auto-merge while the host has not computed readiness", () => {
    expect(
      resolvePullRequestPrimaryControl({
        ...open,
        checksState: "pending",
        mergeReadiness: "unknown",
      }),
    ).toBe("enable-auto-merge");
    expect(resolvePullRequestPrimaryControl({ ...open, mergeReadiness: "unknown" })).toBe("merge");
  });

  it("does not offer auto-merge while the host state is unknown", () => {
    expect(
      resolvePullRequestPrimaryControl({
        ...open,
        checksState: "pending",
        mergeReadiness: undefined,
        autoMergeEnabled: undefined,
      }),
    ).toBe("merge");
  });

  it("keeps armed and terminal states in the merge button slot", () => {
    expect(resolvePullRequestPrimaryControl({ ...open, autoMergeEnabled: true })).toBe(
      "auto-merge-armed",
    );
    expect(resolvePullRequestPrimaryControl({ ...open, state: "merged" })).toBe("merged");
    expect(resolvePullRequestPrimaryControl({ ...open, state: "closed" })).toBe("closed");
  });

  it("keeps conflicts and drafts actionable before merge", () => {
    expect(resolvePullRequestPrimaryControl({ ...open, mergeability: "conflicting" })).toBe(
      "resolve",
    );
    expect(resolvePullRequestPrimaryControl({ ...open, isDraft: true })).toBe("ready");
  });

  it("offers conflict resolution to a reader who cannot merge", () => {
    expect(
      resolvePullRequestPrimaryControl({
        ...open,
        mergeability: "conflicting",
        canMerge: false,
        canEnableAutoMerge: false,
      }),
    ).toBe("resolve");
  });

  it("offers no merge for a draft the reader cannot mark ready", () => {
    expect(resolvePullRequestPrimaryControl({ ...open, isDraft: true, canMarkReady: false })).toBe(
      null,
    );
  });
});

describe("pull request merge now", () => {
  const blocked = {
    state: "open" as const,
    isDraft: false,
    mergeability: "mergeable" as const,
    checksState: "pending" as const,
    mergeReadiness: "blocked" as const,
    autoMergeEnabled: false,
    hasMergeMethod: true,
    canMerge: true,
    canMarkReady: true,
    canEnableAutoMerge: true,
    canBypassRequirements: false,
  };

  it("offers no merge the host would refuse", () => {
    expect(resolvePullRequestMergeNow(blocked)).toBeNull();
    expect(resolvePullRequestMergeNow({ ...blocked, autoMergeEnabled: true })).toBeNull();
    expect(resolvePullRequestMergeNow({ ...blocked, canEnableAutoMerge: false })).toBeNull();
  });

  it("offers a bypassing merge to a viewer the host lets bypass its requirements", () => {
    const bypass = { ...blocked, canBypassRequirements: true };
    expect(resolvePullRequestMergeNow(bypass)).toBe("bypass");
    expect(resolvePullRequestMergeNow({ ...bypass, autoMergeEnabled: true })).toBe("bypass");
    expect(resolvePullRequestMergeNow({ ...bypass, canEnableAutoMerge: false })).toBe("bypass");
  });

  it("offers a plain merge beside auto-merge when readiness is not reported", () => {
    expect(resolvePullRequestMergeNow({ ...blocked, mergeReadiness: "unknown" })).toBe("merge");
    expect(resolvePullRequestMergeNow({ ...blocked, mergeReadiness: undefined })).toBe("merge");
  });

  it("adds nothing when Merge is already the primary control", () => {
    expect(
      resolvePullRequestMergeNow({
        ...blocked,
        checksState: "passing",
        mergeReadiness: "ready",
        canBypassRequirements: true,
      }),
    ).toBeNull();
  });

  it("offers nothing for drafts, conflicts, or a viewer who cannot merge", () => {
    const bypass = { ...blocked, canBypassRequirements: true };
    expect(resolvePullRequestMergeNow({ ...bypass, isDraft: true })).toBeNull();
    expect(resolvePullRequestMergeNow({ ...bypass, mergeability: "conflicting" })).toBeNull();
    expect(resolvePullRequestMergeNow({ ...bypass, canMerge: false })).toBeNull();
  });
});
