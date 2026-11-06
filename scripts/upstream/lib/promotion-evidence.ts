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

export function requiredIntakeSteps(name: string): ReadonlyArray<string> {
  if (/^Fork Test \(Server [123]\/3\)$/u.test(name)) return ["Test server"];
  const steps: Record<string, ReadonlyArray<string>> = {
    "Fork Lint": ["Check"],
    "Fork Typecheck": ["Typecheck"],
    "Fork Build": ["Build desktop pipeline"],
    "Fork Browser Calibration (Linux)": ["Capture calibration snapshots"],
    "Fork Test (Device Windows)": ["Test device commands"],
    "Fork Release Smoke (Run)": ["Exercise release-only workflow steps"],
    "Fork Test (Workspace Web 1/2)": ["Test web shard", "Test workspace packages"],
    "Fork Test (Workspace Web 2/2)": [
      "Test web shard",
      "Test image compression",
      "Test Rust crates",
    ],
    "Fork Test (Workspace Clients)": ["Test workspace packages"],
    "Fork Test (Workspace Other)": [
      "Test workspace packages",
      "Test workspace packages that load the server",
    ],
    "Fork Test (Workspace E2E)": [
      "Build web client for e2e",
      "Build server bundle for e2e",
      "Test end to end",
    ],
  };
  return steps[name] ?? [];
}

export function requireIntakeJobs(
  jobs: ReadonlyArray<{
    readonly name: string;
    readonly status: string;
    readonly conclusion: string | null;
    readonly steps?: ReadonlyArray<{ readonly name: string; readonly conclusion: string | null }>;
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
    for (const step of requiredIntakeSteps(name)) {
      const evidence = matches[0]!.steps?.filter((entry) => entry.name === step) ?? [];
      if (evidence.length !== 1 || evidence[0]!.conclusion !== "success") {
        throw new Error(`Required intake step did not execute successfully: ${name}: ${step}`);
      }
    }
  }
}
