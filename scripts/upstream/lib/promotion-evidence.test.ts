import { assert, it } from "@effect/vitest";
import {
  nativeChecksPassed,
  promotionLane,
  requiredIntakeJobs,
  requiredIntakeSteps,
  requireIntakeJobs,
} from "./promotion-evidence.ts";

it("rejects absent, skipped and incomplete matrix evidence", () => {
  const jobs = requiredIntakeJobs.map((name) => ({
    name,
    status: "completed",
    conclusion: "success",
    steps: requiredIntakeSteps(name).map((name) => ({ name, conclusion: "success" })),
  }));
  assert.doesNotThrow(() => requireIntakeJobs(jobs));
  for (const name of requiredIntakeJobs) {
    assert.throws(() => requireIntakeJobs(jobs.filter((job) => job.name !== name)));
    assert.throws(() =>
      requireIntakeJobs(
        jobs.map((job) => (job.name === name ? { ...job, conclusion: "skipped" } : job)),
      ),
    );
  }
});

it("rejects green jobs whose required test steps were skipped", () => {
  assert.throws(() =>
    requireIntakeJobs(
      requiredIntakeJobs.map((name) => ({
        name,
        status: "completed",
        conclusion: "success",
        steps: [],
      })),
    ),
  );
});

it("rejects each skipped required test step", () => {
  for (const name of requiredIntakeJobs) {
    for (const skipped of requiredIntakeSteps(name)) {
      assert.throws(() =>
        requireIntakeJobs(
          requiredIntakeJobs.map((job) => ({
            name: job,
            status: "completed",
            conclusion: "success",
            steps: requiredIntakeSteps(job).map((step) => ({
              name: step,
              conclusion: job === name && step === skipped ? "skipped" : "success",
            })),
          })),
        ),
      );
    }
  }
});

it("widens only audit-clean native candidates with successful native CI evidence", () => {
  for (const fingerprint of ["unknown"]) {
    assert.equal(promotionLane(true, fingerprint, true).lane, "automatic");
    assert.equal(promotionLane(true, fingerprint, false).lane, "manual");
    assert.equal(promotionLane(false, fingerprint, true).lane, "manual");
  }
  assert.equal(promotionLane(true, "unchanged", false).lane, "automatic");
  assert.equal(promotionLane(false, "unchanged", true).lane, "manual");
  assert.equal(promotionLane(true, undefined, true).lane, "manual");
  assert.equal(promotionLane(true, "invalid", true).lane, "manual");
  assert.equal(promotionLane(true, "moved", true).lane, "manual");
});

it("requires the candidate's completed Fork macOS run and successful native lint guard", () => {
  const sha = "a".repeat(40);
  const run = {
    head_sha: sha,
    head_branch: "intake/fixture",
    event: "push",
    path: ".github/workflows/fork-macos.yml",
    status: "completed",
    conclusion: "success",
  };
  const job = { name: "Fork Mobile Native Lint", status: "completed", conclusion: "success" };
  assert.isTrue(nativeChecksPassed(sha, "intake/fixture", run, [job]));
  assert.isTrue(nativeChecksPassed(sha, "intake/fixture", { ...run, head_branch: "main" }, [job]));
  assert.isFalse(nativeChecksPassed(sha, "intake/fixture", undefined, [job]));
  for (const override of [
    { head_sha: "b".repeat(40) },
    { event: "pull_request" },
    { head_branch: "intake/other" },
    { path: ".github/workflows/other.yml" },
    { status: "in_progress" },
    { conclusion: "failure" },
    { conclusion: "cancelled" },
  ])
    assert.isFalse(nativeChecksPassed(sha, "intake/fixture", { ...run, ...override }, [job]));
  for (const jobs of [
    [],
    [job, job],
    [{ ...job, conclusion: "skipped" }],
    [{ ...job, status: "in_progress" }],
    [{ ...job, conclusion: "failure" }],
  ]) {
    assert.isFalse(nativeChecksPassed(sha, "intake/fixture", run, jobs));
  }
});
