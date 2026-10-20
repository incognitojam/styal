import { assert, describe, it } from "@effect/vitest";
import { holdingCandidates, pullRequestStatus, type WorkflowRun } from "./landing-hold.ts";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function forkCi(overrides: Partial<WorkflowRun>): WorkflowRun {
  return {
    event: "push",
    status: "completed",
    conclusion: "success",
    head_branch: "intake/batch",
    head_sha: SHA_A,
    display_title: "Fork CI",
    html_url: "https://example.test/ci",
    updated_at: "2026-10-20T11:00:00Z",
    ...overrides,
  };
}

function promotion(sha: string, overrides: Partial<WorkflowRun>): WorkflowRun {
  return {
    event: "workflow_run",
    status: "completed",
    conclusion: "success",
    head_branch: "main",
    head_sha: "c".repeat(40),
    display_title: `Promote intake/batch at ${sha}`,
    html_url: "https://example.test/promotion",
    updated_at: "2026-10-20T11:30:00Z",
    ...overrides,
  };
}

describe("holdingCandidates", () => {
  it("holds while an intake branch runs Fork CI", () => {
    const holding = holdingCandidates(
      [forkCi({ status: "in_progress", conclusion: null })],
      [],
      NOW,
    );
    assert.deepStrictEqual(holding, [
      { branch: "intake/batch", sha: SHA_A, url: "https://example.test/ci" },
    ]);
  });

  it("ignores Fork CI on pull requests and main", () => {
    const holding = holdingCandidates(
      [
        forkCi({ status: "in_progress", event: "pull_request", head_branch: "intake/batch" }),
        forkCi({ status: "in_progress", head_branch: "main" }),
      ],
      [],
      NOW,
    );
    assert.deepStrictEqual(holding, []);
  });

  it("holds while the promotion waits for approval", () => {
    const holding = holdingCandidates(
      [forkCi({})],
      [promotion(SHA_A, { status: "waiting", conclusion: null })],
      NOW,
    );
    assert.deepStrictEqual(holding, [
      { branch: "intake/batch", sha: SHA_A, url: "https://example.test/promotion" },
    ]);
  });

  it("holds between Fork CI passing and its promotion run appearing", () => {
    const holding = holdingCandidates([forkCi({ updated_at: "2026-10-20T11:55:00Z" })], [], NOW);
    assert.strictEqual(holding.length, 1);
    assert.strictEqual(holding[0]?.until, Date.parse("2026-10-20T12:10:00Z"));
  });

  it("releases once the promotion finishes, however it ends", () => {
    for (const conclusion of ["success", "failure", "cancelled"]) {
      const holding = holdingCandidates(
        [forkCi({ updated_at: "2026-10-20T11:55:00Z" })],
        [promotion(SHA_A, { conclusion, updated_at: "2026-10-20T11:58:00Z" })],
        NOW,
      );
      assert.deepStrictEqual(holding, [], conclusion);
    }
  });

  it("keeps holding for a fixed push after the branch's newest Fork CI run fails", () => {
    const holding = holdingCandidates(
      [forkCi({ conclusion: "failure", updated_at: "2026-10-20T11:58:00Z" })],
      [],
      NOW,
    );
    assert.deepStrictEqual(holding, [
      {
        branch: "intake/batch",
        sha: SHA_A,
        url: "https://example.test/ci",
        until: Date.parse("2026-10-20T12:08:00Z"),
      },
    ]);
  });

  it("releases after a failure once the grace period ends or a newer run supersedes it", () => {
    const expired = holdingCandidates(
      [forkCi({ conclusion: "failure", updated_at: "2026-10-20T11:45:00Z" })],
      [],
      NOW,
    );
    assert.deepStrictEqual(expired, []);

    // The newer run passed and promoted, so the older failure no longer holds.
    const superseded = holdingCandidates(
      [
        forkCi({ head_sha: SHA_B, updated_at: "2026-10-20T11:50:00Z" }),
        forkCi({ conclusion: "failure", updated_at: "2026-10-20T11:58:00Z" }),
      ],
      [promotion(SHA_B, { updated_at: "2026-10-20T11:55:00Z" })],
      NOW,
    );
    assert.deepStrictEqual(superseded, []);
  });

  it("releases when Fork CI passed long ago without a promotion or was cancelled", () => {
    const holding = holdingCandidates(
      [
        forkCi({ conclusion: "cancelled", updated_at: "2026-10-20T11:58:00Z" }),
        forkCi({ head_sha: SHA_B, head_branch: "intake/old", updated_at: "2026-10-19T08:00:00Z" }),
      ],
      [],
      NOW,
    );
    assert.deepStrictEqual(holding, []);
  });
});

describe("pullRequestStatus", () => {
  it("is success with nothing landing and pending with a link otherwise", () => {
    assert.strictEqual(pullRequestStatus([]).state, "success");
    const held = pullRequestStatus([
      { branch: "intake/batch", sha: SHA_A, url: "https://example.test/ci" },
      { branch: "intake/other", sha: SHA_B, url: "https://example.test/other" },
    ]);
    assert.deepStrictEqual(held, {
      state: "pending",
      description: "Waiting for intake/batch and 1 more to land",
      target_url: "https://example.test/ci",
    });
  });
});
