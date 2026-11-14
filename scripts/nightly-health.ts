// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- Runs in github-script and a dependency-free read-only gh CLI.
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

type Job = {
  name: string;
  conclusion: string | null;
  check_run_url?: string;
  steps?: { name: string; conclusion: string | null }[];
};
type Issue = { number: number; pull_request?: unknown };
type Outcome = {
  results: Readonly<Record<string, string>>;
  workflowDryRun: boolean;
  npmRequired: boolean;
};
type Run = Outcome & { html_url: string; head_sha: string; runId: string; runAttempt: number };
type Request = <T>(method: string, path: string, body?: object) => Promise<T>;

export function healthAction(outcome: Outcome, issues: Issue[]) {
  const results = Object.entries(outcome.results)
    .filter(([name]) => name !== "notify_failure" && name !== "nightly_health")
    .map(([, result]) => result);
  if (results.includes("cancelled")) return "ignored";
  if (results.includes("failure")) return issues.length ? "would skip" : "would open";
  if (
    !outcome.workflowDryRun &&
    outcome.results.release === "success" &&
    (!outcome.npmRequired || outcome.results.publish_cli === "success") &&
    results.every((result) => result === "success" || result === "skipped")
  )
    return issues.length ? "would close" : "nothing to close";
  return "ignored";
}

function inertText(text: string, limit = 500) {
  return "`" + text.replaceAll("`", "'").replace(/\s+/g, " ").trim().slice(0, limit) + "`";
}

export function failureBody(run: Run, jobs: Job[], errors: Record<string, string> = {}) {
  return [
    `Run: ${run.html_url} (attempt ${run.runAttempt})`,
    `Commit: ${run.head_sha}`,
    "",
    ...jobs
      .filter((job) => job.conclusion === "failure")
      .flatMap((job) => {
        const steps = job.steps?.filter((step) => step.conclusion === "failure") ?? [];
        return steps.length
          ? steps.map(
              (step) =>
                `- ${inertText(job.name, 200)}: ${inertText(step.name, 200)}${Object.hasOwn(errors, job.name) ? ` — ${inertText(errors[job.name]!)}` : ""}`,
            )
          : [`- ${inertText(job.name, 200)}: failed step unavailable`];
      }),
  ].join("\n");
}

export async function syncNightlyHealth(options: {
  request: Request;
  repo: string;
  run: Run;
  warn?: (message: string) => void;
  dryRun: boolean;
  announce?: (issue: {
    number: number;
    title: string;
    html_url: string;
    user: { login: string } | null;
  }) => Promise<void>;
}) {
  const { request, repo, run, dryRun, announce, warn } = options;
  const runId = run.runId;
  const root = `/repos/${repo}`;
  if (healthAction(run, []) === "ignored") return "ignored";
  const issues: Issue[] = [];
  for (let page = 1; ; page++) {
    const batch = await request<Issue[]>(
      "GET",
      `${root}/issues?state=open&labels=nightly-failure&per_page=100&page=${page}`,
    );
    issues.push(...batch.filter((issue) => !issue.pull_request));
    if (batch.length < 100) break;
  }
  const action = healthAction(run, issues);
  if (action === "would skip" || action === "nothing to close") return action;
  if (action === "would close") {
    if (!dryRun) {
      for (const issue of issues) {
        const body = `Fork Nightly recovered: ${run.html_url}`;
        let commented = false;
        for (let page = 1; ; page++) {
          const comments = await request<{ body: string }[]>(
            "GET",
            `${root}/issues/${issue.number}/comments?per_page=100&page=${page}`,
          );
          if (comments.some((comment) => comment.body === body)) {
            commented = true;
            break;
          }
          if (comments.length < 100) break;
        }
        if (!commented) await request("POST", `${root}/issues/${issue.number}/comments`, { body });
        await request("PATCH", `${root}/issues/${issue.number}`, {
          state: "closed",
          state_reason: "completed",
        });
      }
    }
    return action;
  }
  const jobs: Job[] = [];
  for (let page = 1; ; page++) {
    const batch = await request<{ jobs: Job[] }>(
      "GET",
      `${root}/actions/runs/${runId}/jobs?filter=latest&per_page=100&page=${page}`,
    );
    jobs.push(...batch.jobs);
    if (batch.jobs.length < 100) break;
  }
  const errors: Record<string, string> = Object.create(null);
  for (const job of jobs.filter((job) => job.conclusion === "failure")) {
    // Annotations are already runner-marked errors; never copy unfiltered logs.
    if (
      !job.check_run_url ||
      job.steps?.filter((step) => step.conclusion === "failure").length !== 1
    )
      continue;
    try {
      const annotations = await request<{ annotation_level: string; message: string }[]>(
        "GET",
        `${new URL(job.check_run_url).pathname}/annotations?per_page=100`,
      );
      const error = annotations.find((annotation) => annotation.annotation_level === "failure");
      if (error) errors[job.name] = error.message.split(/\r?\n/)[0]!.slice(0, 500);
    } catch {
      // Some tokens cannot read check annotations; job and step names still identify the failure.
    }
  }
  const body = failureBody(run, jobs, errors);
  if (dryRun) return `${action}\n${body}`;
  for (const label of [
    {
      name: "nightly-failure",
      color: "b60205",
      description: "Fork Nightly is failing; closes on recovery.",
    },
    { name: "bug", color: "d73a4a", description: "Something isn't working" },
    {
      name: "needs-triage",
      color: "fbca04",
      description: "Issue needs maintainer review and initial categorization.",
    },
  ]) {
    // POST is idempotent here only when the label already exists (422).
    try {
      await request("GET", `${root}/labels/${label.name}`);
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
      try {
        await request("POST", `${root}/labels`, label);
      } catch (creationError) {
        if ((creationError as { status?: number }).status !== 422) throw creationError;
        await request("GET", `${root}/labels/${label.name}`);
      }
    }
  }
  const issue = await request<Parameters<NonNullable<typeof announce>>[0]>(
    "POST",
    `${root}/issues`,
    {
      title: "Fork Nightly is failing",
      body,
      labels: ["nightly-failure", "bug", "needs-triage"],
    },
  );
  try {
    await announce?.(issue);
  } catch {
    warn?.("Discord issue announcement could not be delivered.");
  }
  return `opened #${issue.number}`;
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  const runId = process.argv[2];
  if (!runId || !process.argv.includes("--dry-run"))
    throw new Error("Usage: node scripts/nightly-health.ts RUN_ID --dry-run");
  const request: Request = async <T>(method: string, path: string) => {
    if (method !== "GET") throw new Error("Dry run permits GET requests only");
    return JSON.parse(
      NodeChildProcess.execFileSync("gh", ["api", path], {
        encoding: "utf8",
        env: { ...process.env, GH_REPO: "incognitojam/styal" },
        stdio: ["ignore", "pipe", "ignore"],
      }),
    ) as T;
  };
  const root = "/repos/incognitojam/styal";
  const metadata = await request<{
    name: string;
    conclusion: string | null;
    html_url: string;
    head_sha: string;
    run_attempt: number;
  }>("GET", `${root}/actions/runs/${runId}`);
  if (metadata.name !== "Fork Nightly") throw new Error("Expected a Fork Nightly run");
  const jobs: Job[] = [];
  for (let page = 1; ; page++) {
    const batch = await request<{ jobs: Job[] }>(
      "GET",
      `${root}/actions/runs/${runId}/jobs?filter=latest&per_page=100&page=${page}`,
    );
    jobs.push(...batch.jobs);
    if (batch.jobs.length < 100) break;
  }
  const release = jobs.find((job) => job.name === "Publish GitHub prerelease");
  const npm = jobs.filter((job) => job.name.startsWith("Publish CLI to npm /"));
  const run: Run = {
    ...metadata,
    runId,
    runAttempt: metadata.run_attempt,
    results: {
      ...Object.fromEntries(
        jobs
          .filter(
            (job) =>
              job.name !== "Notify Discord of failure" && job.name !== "Track nightly health",
          )
          .map((job) => [job.name, job.conclusion ?? "in_progress"]),
      ),
      release: release?.conclusion ?? "skipped",
      publish_cli: npm.some((job) => job.conclusion === "failure")
        ? "failure"
        : npm.some((job) => job.conclusion === "success")
          ? "success"
          : "skipped",
      workflow:
        metadata.conclusion === "cancelled"
          ? "cancelled"
          : metadata.conclusion === null
            ? "in_progress"
            : "success",
    },
    workflowDryRun: !release?.steps?.some(
      (step) => step.name === "Publish complete prerelease" && step.conclusion === "success",
    ),
    npmRequired: npm.length > 0,
  };
  console.log(await syncNightlyHealth({ request, repo: "incognitojam/styal", run, dryRun: true }));
}
