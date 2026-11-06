import { assert, it } from "@effect/vitest";
import { requiredIntakeJobs, requireIntakeJobs } from "./promotion-evidence.ts";

it("rejects absent, skipped and incomplete matrix evidence", () => {
  const jobs = requiredIntakeJobs.map((name) => ({
    name,
    status: "completed",
    conclusion: "success",
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
