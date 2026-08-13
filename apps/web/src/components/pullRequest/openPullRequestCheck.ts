import type {
  ExecutionEnvironmentPlatformOs,
  PullRequestCheck,
  SourceControlProviderKind,
} from "@t3tools/contracts";

import {
  GITHUB_ACTIONS_JOB,
  GITHUB_ACTIONS_LOG_BEGIN,
  GITHUB_ACTIONS_SNAPSHOT_BEGIN,
  GITHUB_ACTIONS_SNAPSHOT_END,
  GITHUB_ACTIONS_STEP,
  type GitHubActionsLogPresentation,
} from "~/terminal/terminalOutputPresentation";

export interface GitHubActionsJobTarget {
  readonly hostname: string;
  readonly repository: string;
  readonly jobId: string;
}

export type PullRequestCheckOpenPlan =
  | {
      readonly kind: "terminal";
      readonly command: string;
      readonly presentation: GitHubActionsLogPresentation;
    }
  | { readonly kind: "external"; readonly url: string };

const SAFE_REPOSITORY_PART = /^[A-Za-z0-9_.-]+$/u;
const SAFE_HOST = /^[A-Za-z0-9.-]+$/u;
const NUMERIC_ID = /^\d+$/u;
const WAITING_POLL_SECONDS = 15;
const RUNNING_POLL_SECONDS = 10;
const LOG_RETRY_SECONDS = 2;

/** Only Actions job links contain everything `gh` needs without another provider-shaped read. */
export function parseGitHubActionsJobUrl(rawUrl: string): GitHubActionsJobTarget | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !SAFE_HOST.test(url.hostname)) return null;

  const parts = url.pathname.split("/").filter(Boolean);
  const [owner, repository, actions, runs, runId, job, jobId] = parts;
  if (
    parts.length < 7 ||
    !owner ||
    !repository ||
    actions !== "actions" ||
    runs !== "runs" ||
    job !== "job" ||
    !runId ||
    !jobId ||
    !SAFE_REPOSITORY_PART.test(owner) ||
    !SAFE_REPOSITORY_PART.test(repository) ||
    !NUMERIC_ID.test(runId) ||
    !NUMERIC_ID.test(jobId)
  ) {
    return null;
  }

  return {
    hostname: url.hostname,
    repository: `${owner}/${repository}`,
    jobId,
  };
}

export function resolvePullRequestCheckOpenPlan(
  provider: SourceControlProviderKind,
  check: PullRequestCheck,
  platform: ExecutionEnvironmentPlatformOs = "unknown",
): PullRequestCheckOpenPlan | null {
  if (check.url === null) return null;
  if (provider !== "github") return { kind: "external", url: check.url };

  const target = parseGitHubActionsJobUrl(check.url);
  if (target === null) return { kind: "external", url: check.url };

  const hostArgument = target.hostname === "github.com" ? "" : ` --hostname ${target.hostname}`;
  const viewJob = `gh api${hostArgument} repos/${target.repository}/actions/jobs/${target.jobId}`;
  const viewLog = `gh api --allow-escape-sequences${hostArgument} repos/${target.repository}/actions/jobs/${target.jobId}/logs`;
  const command = buildJobLogCommand(viewJob, viewLog, platform);
  return {
    kind: "terminal",
    command,
    presentation: {
      kind: "github-actions-log",
      title: check.name,
      command,
    },
  };
}

function quotePosixShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function buildJobLogCommand(
  viewJob: string,
  viewLog: string,
  platform: ExecutionEnvironmentPlatformOs,
): string {
  const snapshotFilter = `(["${GITHUB_ACTIONS_JOB}", .status, (.conclusion // ""), (.started_at // ""), (.completed_at // "")] | @tsv), ((.steps // [])[] | ["${GITHUB_ACTIONS_STEP}", .status, (.conclusion // ""), .name, (.started_at // ""), (.completed_at // "")] | @tsv)`;
  if (platform === "windows") {
    return `$s = @(); $st = ''; $f = 0; while ($true) { $s = @(${viewJob} --jq '${snapshotFilter}'); if ($LASTEXITCODE -eq 0) { $f = 0; Write-Output '${GITHUB_ACTIONS_SNAPSHOT_BEGIN}'; $s; Write-Output '${GITHUB_ACTIONS_SNAPSHOT_END}'; $st = ($s[0] -split [char]9)[1]; if ($st -eq 'completed') { break } } else { $f += 1; if ($f -ge 3) { break } }; $d = if ($st -eq 'in_progress') { ${RUNNING_POLL_SECONDS} } else { ${WAITING_POLL_SECONDS} }; Start-Sleep -Seconds $d }; if ($st -eq 'completed') { 1..3 | ForEach-Object { Write-Output '${GITHUB_ACTIONS_LOG_BEGIN}'; ${viewLog}; if ($LASTEXITCODE -eq 0) { break }; Start-Sleep -Seconds ${LOG_RETRY_SECONDS} } }`;
  }

  const snapshotCommand = `${viewJob} --jq ${quotePosixShell(snapshotFilter)}`;
  const script = `s=;st=;f=0;while :;do if s="$(${snapshotCommand})";then f=0;printf '${GITHUB_ACTIONS_SNAPSHOT_BEGIN}\\n%s\\n${GITHUB_ACTIONS_SNAPSHOT_END}\\n' "$s";st="$(printf '%s\\n' "$s"|head -n1|cut -f2)";[ "$st" = completed ]&&break;else f=$((f+1));[ "$f" -ge 3 ]&&break;fi;if [ "$st" = in_progress ];then sleep ${RUNNING_POLL_SECONDS};else sleep ${WAITING_POLL_SECONDS};fi;done;if [ "$st" = completed ];then i=0;while [ "$i" -lt 3 ];do printf '${GITHUB_ACTIONS_LOG_BEGIN}\\n';${viewLog}&&break;i=$((i+1));[ "$i" -lt 3 ]&&sleep ${LOG_RETRY_SECONDS};done;fi`;
  return `sh -c ${quotePosixShell(script)}`;
}
