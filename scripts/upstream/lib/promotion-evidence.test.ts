import { assert, it } from "@effect/vitest";
import {
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
