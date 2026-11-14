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
type Run = { html_url: string; head_sha: string; conclusion: string | null; name: string };
type Request = <T>(method: string, path: string, body?: object) => Promise<T>;

export function healthAction(conclusion: string | null, issues: Issue[]) {
  if (conclusion === "failure") return issues.length ? "would skip" : "would open";
  if (conclusion === "success") return issues.length ? "would close" : "nothing to close";
  return "ignored";
}

export function failureBody(run: Run, jobs: Job[], errors: Record<string, string> = {}) {
  return [
    `Run: ${run.html_url}`,
    `Commit: ${run.head_sha}`,
    "",
    ...jobs
      .filter((job) => job.conclusion === "failure")
      .flatMap((job) => {
        const steps = job.steps?.filter((step) => step.conclusion === "failure") ?? [];
        return steps.length
          ? steps.map(
              (step) =>
                `- ${job.name}: ${step.name}${errors[job.name] ? ` — ${errors[job.name]}` : ""}`,
            )
          : [`- ${job.name}: failed step unavailable`];
      }),
  ].join("\n");
}

export async function syncNightlyHealth(options: {
  request: Request;
  repo: string;
  runId: string;
  conclusion?: string;
  commit?: string;
  dryRun: boolean;
  announce?: (issue: {
    number: number;
    title: string;
    html_url: string;
    user: { login: string } | null;
  }) => Promise<void>;
}) {
  const { request, repo, runId, dryRun, announce } = options;
  const root = `/repos/${repo}`;
  const run = await request<Run>("GET", `${root}/actions/runs/${runId}`);
  if (run.name !== "Fork Nightly") throw new Error("Expected a Fork Nightly run");
  const conclusion = options.conclusion ?? run.conclusion;
  if (conclusion !== "failure" && conclusion !== "success") return "ignored";
  const issues: Issue[] = [];
  for (let page = 1; ; page++) {
    const batch = await request<Issue[]>(
      "GET",
      `${root}/issues?state=open&labels=nightly-failure&per_page=100&page=${page}`,
    );
    issues.push(...batch.filter((issue) => !issue.pull_request));
    if (batch.length < 100) break;
  }
  const action = healthAction(conclusion, issues);
  if (action === "would skip" || action === "nothing to close") return action;
  if (action === "would close") {
    if (!dryRun) {
      for (const issue of issues) {
        await request("POST", `${root}/issues/${issue.number}/comments`, {
          body: `Fork Nightly recovered: ${run.html_url}`,
        });
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
  const errors: Record<string, string> = {};
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
  const body = failureBody({ ...run, head_sha: options.commit || run.head_sha }, jobs, errors);
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
  await announce?.(issue);
  return `opened #${issue.number}`;
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  const runId = process.argv[2];
  if (!runId || !process.argv.includes("--dry-run"))
    throw new Error("Usage: node scripts/nightly-health.ts RUN_ID --dry-run");
  const request: Request = async <T>(_method: string, path: string) =>
    JSON.parse(
      NodeChildProcess.execFileSync("gh", ["api", path], {
        encoding: "utf8",
        env: { ...process.env, GH_REPO: "incognitojam/styal" },
        stdio: ["ignore", "pipe", "ignore"],
      }),
    ) as T;
  console.log(
    await syncNightlyHealth({ request, repo: "incognitojam/styal", runId, dryRun: true }),
  );
}
