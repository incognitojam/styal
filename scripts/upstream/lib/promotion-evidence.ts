export const requiredIntakeJobs = [
  "Fork Changes",
  "Fork Intake Audit",
  "Fork Lint",
  "Fork Typecheck",
  "Fork Build",
  "Fork Browser Calibration (Linux)",
  "Fork Check",
  "Fork Test (Device Windows)",
  "Fork Test (Server)",
  "Fork Test (Workspace)",
  "Fork Release Smoke (Run)",
  "Fork Release Smoke",
  ...[1, 2, 3].map((shard) => `Fork Test (Server ${shard}/3)`),
  ...["Web 1/2", "Web 2/2", "Clients", "E2E", "Other"].map(
    (suite) => `Fork Test (Workspace ${suite})`,
  ),
];

export function requireIntakeJobs(
  jobs: ReadonlyArray<{
    readonly name: string;
    readonly status: string;
    readonly conclusion: string | null;
  }>,
): void {
  for (const name of requiredIntakeJobs) {
    const matches = jobs.filter((job) => job.name === name);
    if (
      matches.length !== 1 ||
      matches[0]!.status !== "completed" ||
      matches[0]!.conclusion !== "success"
    ) {
      throw new Error(`Required intake job did not execute successfully: ${name}`);
    }
  }
}
