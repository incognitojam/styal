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

export function nativeChecksPassed(
  sha: string,
  branch: string,
  run:
    | {
        readonly head_sha: string;
        readonly head_branch: string;
        readonly event: string;
        readonly path: string;
        readonly status: string;
        readonly conclusion: string | null;
      }
    | undefined,
  jobs: ReadonlyArray<{
    readonly name: string;
    readonly status: string;
    readonly conclusion: string | null;
  }>,
): boolean {
  const lint = jobs.filter((job) => job.name === "Fork Mobile Native Lint");
  return (
    run?.head_sha === sha &&
    // Main's push run can supersede the intake run when replaying a landed candidate.
    (run.head_branch === branch || run.head_branch === "main") &&
    run.event === "push" &&
    run.path === ".github/workflows/fork-macos.yml" &&
    run.status === "completed" &&
    run.conclusion === "success" &&
    lint.length === 1 &&
    lint[0]!.status === "completed" &&
    lint[0]!.conclusion === "success"
  );
}

export function promotionLane(
  eligible: boolean,
  fingerprint: string | undefined,
  nativePassed: boolean,
) {
  if (!eligible)
    return { lane: "manual", reason: "The audit requires manual approval; see its reasons above." };
  if (fingerprint === "unchanged")
    return {
      lane: "automatic",
      reason: "The audit is clean and native fingerprint inputs are unchanged.",
    };
  if (fingerprint === "unknown" && nativePassed) {
    return {
      lane: "automatic",
      reason:
        "The audit is clean and Fork macOS, including its native lint gate, passed on the candidate. Native runtime changes may require new production builds.",
    };
  }
  return {
    lane: "manual",
    reason:
      "Native fingerprint inputs may have changed without successful Fork macOS and native lint evidence.",
  };
}

export function readNativeChecks(api: (path: string) => string, sha: string, branch: string) {
  type Run = NonNullable<Parameters<typeof nativeChecksPassed>[2]> & {
    readonly id: number;
    readonly run_attempt: number;
    readonly html_url: string;
  };
  const runs = (
    JSON.parse(
      api(`workflows/fork-macos.yml/runs?head_sha=${sha}&event=push&per_page=100`),
    ) as Array<{ workflow_runs: Array<Run> }>
  ).flatMap((page) => page.workflow_runs);
  const run = runs.sort((a, b) => b.id - a.id)[0];
  const jobs =
    run?.status === "completed" && run.conclusion === "success"
      ? (
          JSON.parse(api(`runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`)) as Array<{
            jobs: Parameters<typeof nativeChecksPassed>[3];
          }>
        ).flatMap((page) => page.jobs)
      : [];
  return { passed: nativeChecksPassed(sha, branch, run, jobs), url: run?.html_url };
}
