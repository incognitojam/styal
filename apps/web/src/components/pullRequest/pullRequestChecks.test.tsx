import type { PullRequestCheck } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { pullRequestChecksState } from "./pullRequestPresentation";

function check(
  status: PullRequestCheck["status"],
  overrides: Partial<PullRequestCheck> = {},
): PullRequestCheck {
  return { name: `check-${status}`, status, description: null, url: null, ...overrides };
}

describe("pullRequestChecksState", () => {
  it("lets a failure outrank a run still going, and reports nothing without checks", () => {
    expect(pullRequestChecksState([check("success"), check("pending"), check("failure")])).toBe(
      "failing",
    );
    expect(pullRequestChecksState([check("success"), check("cancelled")])).toBe("failing");
    expect(pullRequestChecksState([check("success"), check("pending")])).toBe("pending");
    expect(pullRequestChecksState([check("success"), check("expected")])).toBe("pending");
    expect(pullRequestChecksState([check("success"), check("action-required")])).toBe("pending");
    expect(pullRequestChecksState([check("success")])).toBe("passing");
    expect(pullRequestChecksState([check("skipped"), check("neutral")])).toBe(null);
    expect(pullRequestChecksState([])).toBe(null);
  });
});
