// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalConsole:off globalDate:off preferSchemaOverJson:off
/**
 * Provider canary: decides which provider releases need verification,
 * records verified ones in the model manifest's `autoUpdates`, and keeps one
 * GitHub issue listing what failed.
 *
 *   node scripts/provider-canary.ts plan [--provider <id>] [--force] [--pending <manifest>]
 *   node scripts/provider-canary.ts record --after <styal> --provider <id> --package <npm> --version <x.y.z> [...]
 *   node scripts/provider-canary.ts report --run-url <url> [--plan <json>] [--outcomes <dir>] [--dry-run]
 *
 * The workflow in .github/workflows/provider-canary.yml runs them around
 * apps/server/scripts/verify-provider-live.ts.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { compareSemverVersions, satisfiesSemverRange } from "@t3tools/shared/semver";

const ROOT = NodePath.resolve(import.meta.dirname, "..");
export const MANIFEST_PATH = NodePath.join(ROOT, "apps/server/src/provider/model-manifest.json");

export interface CanaryProvider {
  /** Built-in instance id, which is also the driver kind. */
  readonly provider: string;
  /**
   * npm packages the server updates this provider from. OpenCode 1.x and 2.x
   * ship as different packages and an install is only updated within its own.
   */
  readonly packageNames: ReadonlyArray<string>;
  readonly binary: string;
  /** A cheap model the verifier can run real turns with. */
  readonly model: string;
  /** Repository secret holding the API key the provider authenticates with. */
  readonly secret: string;
}

export const CANARY_PROVIDERS: ReadonlyArray<CanaryProvider> = [
  {
    provider: "codex",
    packageNames: ["@openai/codex"],
    binary: "codex",
    model: "gpt-6-luna",
    secret: "OPENAI_API_KEY",
  },
  {
    provider: "claudeAgent",
    packageNames: ["@anthropic-ai/claude-code"],
    binary: "claude",
    model: "claude-haiku-5-5",
    secret: "ANTHROPIC_API_KEY",
  },
  {
    provider: "opencode",
    packageNames: ["opencode-ai", "@opencode/cli"],
    binary: "opencode",
    model: "anthropic/claude-haiku-5-5",
    secret: "ANTHROPIC_API_KEY",
  },
];

export interface AutoUpdateEntry {
  readonly version: string;
  readonly package: string;
  readonly after: string;
}

interface Policy {
  readonly driver: string;
  readonly t3CodeRange: string;
  readonly autoUpdates?: ReadonlyArray<AutoUpdateEntry>;
  readonly ranges: ReadonlyArray<{ readonly range: string; readonly status: string }>;
}

interface Manifest {
  readonly updatedAt?: string;
  readonly compatibility?: ReadonlyArray<Policy>;
}

/** Entries kept per package; older ones only cover styal releases that rarely run. */
const MAX_ENTRIES_PER_PACKAGE = 3;

export function findPolicyIndex(manifest: Manifest, driver: string, styalVersion: string): number {
  return (manifest.compatibility ?? []).findIndex(
    (policy) => policy.driver === driver && satisfiesSemverRange(styalVersion, policy.t3CodeRange),
  );
}

export function rangeStatus(policy: Policy, version: string): string {
  return (
    policy.ranges.find((entry) => satisfiesSemverRange(version, entry.range))?.status ?? "unknown"
  );
}

/**
 * The version a server built after `after` may install for `packageName`,
 * mirroring `resolveProviderAutoUpdateVersion` on the server.
 */
function verifiedVersion(policy: Policy, packageName: string, after: string): string | undefined {
  let best: string | undefined;
  for (const entry of policy.autoUpdates ?? []) {
    if (entry.package !== packageName || compareSemverVersions(entry.after, after) > 0) continue;
    if (best === undefined || compareSemverVersions(entry.version, best) > 0) best = entry.version;
  }
  return best;
}

/**
 * Adds a verified release to a policy. An entry is dropped when another one
 * for the same package allows at least its version to at least its servers.
 */
export function addAutoUpdate(
  policy: Policy,
  entry: AutoUpdateEntry,
): ReadonlyArray<AutoUpdateEntry> {
  const status = rangeStatus(policy, entry.version);
  if (status !== "supported") {
    throw new Error(`${policy.driver}: ${entry.version} is ${status}, not in a supported range.`);
  }
  const covers = (wide: AutoUpdateEntry, narrow: AutoUpdateEntry) =>
    wide.package === narrow.package &&
    compareSemverVersions(wide.version, narrow.version) >= 0 &&
    compareSemverVersions(wide.after, narrow.after) <= 0;
  const existing = policy.autoUpdates ?? [];
  if (existing.some((other) => covers(other, entry))) return existing;
  const kept = [...existing.filter((other) => !covers(entry, other)), entry];
  const newest = new Set(
    kept
      .filter((other) => other.package === entry.package)
      .toSorted((left, right) => compareSemverVersions(right.after, left.after))
      .slice(0, MAX_ENTRIES_PER_PACKAGE),
  );
  return kept.filter((other) => other.package !== entry.package || newest.has(other));
}

/**
 * Entries in `pending` (an unmerged canary branch's manifest) that `manifest`
 * lacks, matched by policy driver and styal range.
 */
function pendingEntries(
  manifest: Manifest,
  pending: Manifest,
): Array<{ readonly index: number; readonly entry: AutoUpdateEntry }> {
  const found: Array<{ index: number; entry: AutoUpdateEntry }> = [];
  for (const policy of pending.compatibility ?? []) {
    const index = (manifest.compatibility ?? []).findIndex(
      (candidate) =>
        candidate.driver === policy.driver && candidate.t3CodeRange === policy.t3CodeRange,
    );
    if (index === -1) continue;
    for (const entry of policy.autoUpdates ?? []) {
      const known = manifest.compatibility![index]!.autoUpdates ?? [];
      if (!known.some((other) => NodeUtil.isDeepStrictEqual(other, entry)))
        found.push({ index, entry });
    }
  }
  return found;
}

export interface VerifyEntry {
  readonly provider: string;
  readonly packageName: string;
  readonly binary: string;
  readonly version: string;
  readonly model: string;
  readonly secret: string;
}

export type ProviderPlan =
  | { readonly kind: "verify"; readonly entry: VerifyEntry }
  | { readonly kind: "current"; readonly provider: string; readonly reason: string }
  | {
      readonly kind: "blocked";
      readonly provider: string;
      /** The releases that were considered, so a report can tell repeats apart. */
      readonly releases: string;
      readonly reason: string;
    };

/**
 * Plans one provider from the npm `latest` version of each of its packages,
 * for servers built after `after`. The newest version in a supported range is
 * verified when those servers may not install it yet, or always with `force`.
 */
export function planProvider(
  canary: CanaryProvider,
  manifest: Manifest,
  after: string,
  latest: Readonly<Record<string, string>>,
  force = false,
): ProviderPlan {
  const index = findPolicyIndex(manifest, canary.provider, after);
  const policy = manifest.compatibility?.[index];
  const candidates = canary.packageNames
    .flatMap((packageName) => {
      const version = latest[packageName];
      return version && /^\d+\.\d+\.\d+$/.test(version) ? [{ packageName, version }] : [];
    })
    .toSorted((left, right) => compareSemverVersions(right.version, left.version));
  const releases =
    candidates.map((candidate) => `${candidate.packageName}@${candidate.version}`).join(", ") ||
    "no stable release found";
  if (!policy) {
    return {
      kind: "blocked",
      provider: canary.provider,
      releases,
      reason: `No ${canary.provider} compatibility policy covers styal ${after}.`,
    };
  }
  const supported = candidates.find(
    (candidate) => rangeStatus(policy, candidate.version) === "supported",
  );
  if (!supported) {
    const described = candidates
      .map(
        (candidate) =>
          `${candidate.packageName}@${candidate.version} is ${rangeStatus(policy, candidate.version)}`,
      )
      .join(", ");
    return {
      kind: "blocked",
      provider: canary.provider,
      releases,
      reason: `No latest release is in a supported range of the policy for styal ${policy.t3CodeRange} (${described || "no stable release found"}). Review the compatibility ranges.`,
    };
  }
  const recorded = verifiedVersion(policy, supported.packageName, after);
  if (!force && recorded !== undefined && compareSemverVersions(supported.version, recorded) <= 0) {
    return {
      kind: "current",
      provider: canary.provider,
      reason: `${supported.packageName}@${supported.version} is already verified (${recorded}).`,
    };
  }
  return {
    kind: "verify",
    entry: {
      provider: canary.provider,
      packageName: supported.packageName,
      binary: canary.binary,
      version: supported.version,
      model: canary.model,
      secret: canary.secret,
    },
  };
}

/** Byte spans of the top-level objects in the manifest's `compatibility` array. */
function compatibilitySpans(text: string): Array<{ start: number; end: number }> {
  const key = text.indexOf('"compatibility"');
  if (key === -1) throw new Error("The manifest has no compatibility array.");
  const open = text.indexOf("[", key);
  const spans: Array<{ start: number; end: number }> = [];
  let depth = 0;
  let inString = false;
  let start = -1;
  for (let index = open; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (char === "\\") index++;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "[" || char === "{") {
      if (depth === 1 && char === "{") start = index;
      depth++;
    } else if (char === "]" || char === "}") {
      depth--;
      if (depth === 1 && char === "}") spans.push({ start, end: index + 1 });
      if (depth === 0) return spans;
    }
  }
  throw new Error("The manifest's compatibility array is not closed.");
}

export interface RecordEntry {
  readonly provider: string;
  readonly packageName: string;
  readonly version: string;
}

/**
 * Adds verified releases to the policies that apply to servers built after
 * `after`, plus any `pending` entries from an unmerged earlier run, and bumps
 * `updatedAt`. Only the edited policies are rewritten, so the rest of the
 * file keeps its layout. Returns the text unchanged when nothing is new.
 */
export function recordVersions(
  text: string,
  after: string,
  entries: ReadonlyArray<RecordEntry>,
  now: Date,
  pending?: Manifest,
): string {
  const manifest: Manifest = JSON.parse(text);
  const policies = [...(manifest.compatibility ?? [])];
  const additions: Array<{ index: number; entry: AutoUpdateEntry }> = [];
  for (const { provider, packageName, version } of entries) {
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`${provider}: ${version} is not x.y.z.`);
    const index = findPolicyIndex(manifest, provider, after);
    if (index === -1) throw new Error(`${provider}: no policy covers styal ${after}.`);
    additions.push({ index, entry: { version, package: packageName, after } });
  }
  // Pending entries go first so today's results prune them, not the reverse.
  const all = [...(pending ? pendingEntries(manifest, pending) : []), ...additions];
  const edited = new Set<number>();
  for (const { index, entry } of all) {
    const policy = policies[index]!;
    let next: ReadonlyArray<AutoUpdateEntry>;
    try {
      next = addAutoUpdate(policy, entry);
    } catch (error) {
      // A pending entry the policy no longer allows is dropped, not recorded.
      if (additions.some((addition) => addition.entry === entry)) throw error;
      continue;
    }
    if (next === policy.autoUpdates) continue;
    policies[index] = withAutoUpdates(policy, next);
    edited.add(index);
  }
  if (edited.size === 0) return text;

  const updatedAt = now.toISOString();
  if (manifest.updatedAt !== undefined && updatedAt <= manifest.updatedAt) {
    throw new Error(`updatedAt ${updatedAt} is not newer than ${manifest.updatedAt}.`);
  }
  const spans = compatibilitySpans(text);
  let next = text;
  // Edit from the end so earlier spans keep their offsets.
  for (const index of [...edited].toSorted((left, right) => right - left)) {
    const span = spans[index]!;
    const body = next.slice(span.start, span.end);
    const ranges = /\n([ \t]*)"ranges":/.exec(body);
    if (!ranges) throw new Error("A compatibility policy has no ranges.");
    const indent = ranges[1]!;
    const array = JSON.stringify(policies[index]!.autoUpdates, null, 2).replaceAll(
      "\n",
      `\n${indent}`,
    );
    const key = body.indexOf('"autoUpdates":');
    // Entries hold no brackets, so the array ends at the first "]" after it.
    const edited =
      key === -1
        ? `${body.slice(0, ranges.index)}\n${indent}"autoUpdates": ${array},${body.slice(ranges.index)}`
        : `${body.slice(0, key)}"autoUpdates": ${array}${body.slice(body.indexOf("]", key) + 1)}`;
    next = next.slice(0, span.start) + edited + next.slice(span.end);
  }
  const stamp = /("updatedAt":\s*)"[^"]*"/;
  next = stamp.test(next)
    ? next.replace(stamp, `$1"${updatedAt}"`)
    : next.replace(/"version":\s*\d+,/, (match) => `${match}\n  "updatedAt": "${updatedAt}",`);

  const expected = { ...JSON.parse(text), updatedAt, compatibility: policies };
  if (!NodeUtil.isDeepStrictEqual(JSON.parse(next), expected)) {
    throw new Error("Editing the manifest text produced different JSON than intended.");
  }
  return next;
}

/** Sets `autoUpdates`, keeping key order and placing a new key before `ranges`. */
function withAutoUpdates(policy: Policy, autoUpdates: ReadonlyArray<AutoUpdateEntry>): Policy {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(policy)) {
    if (key === "ranges" && !("autoUpdates" in policy)) result.autoUpdates = autoUpdates;
    result[key] = key === "autoUpdates" ? autoUpdates : value;
  }
  return result as unknown as Policy;
}

const STATUS_ISSUE_TITLE = "Provider canary status";

/** One verify job's result, written by the workflow. */
export interface CanaryOutcome {
  readonly provider: string;
  readonly packageName: string;
  readonly version: string;
  /** `flaky` passed on its retry; `skipped` had no credentials. */
  readonly outcome: "passed" | "flaky" | "failed" | "skipped";
  readonly detail: string;
}

export interface CanaryProblem {
  /** Stable across runs, so a problem that persists is reported once. */
  readonly key: string;
  readonly summary: string;
}

export function collectProblems(input: {
  readonly blocked: ReadonlyArray<{ provider: string; releases: string; reason: string }>;
  readonly outcomes: ReadonlyArray<CanaryOutcome>;
  readonly failedJobs: ReadonlyArray<string>;
}): Array<CanaryProblem> {
  return [
    ...input.failedJobs.map((job) => ({
      key: `job:${job}`,
      summary: `The **${job}** job failed. See the run log.`,
    })),
    ...input.blocked.map((entry) => ({
      key: `blocked:${entry.provider}:${entry.releases}`,
      summary: `**${entry.provider}** is not verified: ${entry.reason}`,
    })),
    ...input.outcomes.flatMap((outcome) =>
      outcome.outcome === "failed"
        ? [
            {
              key: `failed:${outcome.provider}@${outcome.version}`,
              summary: `**${outcome.packageName}@${outcome.version}** failed verification twice: ${outcome.detail}`,
            },
          ]
        : outcome.outcome === "skipped"
          ? [
              {
                key: `skipped:${outcome.provider}`,
                summary: `**${outcome.provider}** was not verified: ${outcome.detail}`,
              },
            ]
          : [],
    ),
  ];
}

export interface StatusIssue {
  readonly number: number;
  readonly open: boolean;
  readonly body: string;
}

export interface StatusIssueUpdate {
  readonly body: string;
  readonly state: "open" | "closed";
  /** Posted as a comment, so it notifies; body edits do not. */
  readonly comment?: string;
}

const STATE_MARKER = /<!-- provider-canary-state (.*) -->/;

/**
 * How the status issue changes after a run. A comment is posted only when a
 * problem appears that the open issue does not already list, or when every
 * problem clears and the issue closes. Returns null when nothing changes.
 */
export function reconcileStatusIssue(
  issue: StatusIssue | null,
  problems: ReadonlyArray<CanaryProblem>,
  notes: ReadonlyArray<string>,
  runUrl: string,
): StatusIssueUpdate | null {
  const previous: ReadonlyArray<string> = issue?.open
    ? (JSON.parse(STATE_MARKER.exec(issue.body)?.[1] ?? "{}").keys ?? [])
    : [];
  const body = [
    problems.length > 0
      ? "The provider canary found problems that hold back automatic provider updates. This issue is updated on each run and closes when every check passes."
      : "Every provider canary check passed.",
    problems.map((problem) => `- ${problem.summary}`).join("\n"),
    notes.length > 0 ? `Passed on retry:\n\n${notes.map((note) => `- ${note}`).join("\n")}` : "",
    `Last run: ${runUrl}`,
    `<!-- provider-canary-state ${JSON.stringify({ keys: problems.map((problem) => problem.key) })} -->`,
  ]
    .filter(Boolean)
    .join("\n\n");
  if (problems.length === 0) {
    return issue?.open
      ? { body, state: "closed", comment: `Every check passed in ${runUrl}. Closing.` }
      : null;
  }
  const added = problems.filter((problem) => !previous.includes(problem.key));
  return {
    body,
    state: "open",
    ...(issue !== null && added.length > 0
      ? {
          comment: `New in ${runUrl}:\n\n${added.map((problem) => `- ${problem.summary}`).join("\n")}`,
        }
      : {}),
  };
}

async function fetchDistTags(packageName: string): Promise<Record<string, string>> {
  const response = await fetch(
    `https://registry.npmjs.org/-/package/${packageName.replace("/", "%2f")}/dist-tags`,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (response.status === 404) return {};
  if (!response.ok)
    throw new Error(`Cannot read ${packageName} dist-tags: HTTP ${response.status}`);
  const tags: unknown = await response.json();
  if (!tags || typeof tags !== "object") return {};
  return Object.fromEntries(
    Object.entries(tags).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

/**
 * The newest published styal release. Builds after it contain the code on
 * `main` now, so it bounds which servers a verification applies to.
 */
async function newestStyalRelease(): Promise<string> {
  const tags = await fetchDistTags("@styal/cli");
  const versions = [tags.latest, tags.nightly].filter((version) => version !== undefined);
  const newest = versions.toSorted((left, right) => compareSemverVersions(right, left))[0];
  if (!newest) throw new Error("Cannot find a published @styal/cli release.");
  return newest;
}

function readManifest(path: string | undefined): Manifest | undefined {
  return path && NodeFS.existsSync(path)
    ? JSON.parse(NodeFS.readFileSync(path, "utf8"))
    : undefined;
}

async function plan(args: ReadonlyArray<string>) {
  const { values } = NodeUtil.parseArgs({
    args: [...args],
    options: {
      provider: { type: "string" },
      force: { type: "boolean", default: false },
      pending: { type: "string" },
      json: { type: "string" },
    },
  });
  const selected = CANARY_PROVIDERS.filter(
    (canary) => !values.provider || canary.provider === values.provider,
  );
  if (selected.length === 0) throw new Error(`Unknown canary provider: ${values.provider}`);
  const text = NodeFS.readFileSync(MANIFEST_PATH, "utf8");
  const after = await newestStyalRelease();
  const pending = readManifest(values.pending);
  // Plan against what main will hold once the open canary pull request merges.
  const manifest: Manifest = JSON.parse(
    pending ? recordVersions(text, after, [], new Date(), pending) : text,
  );
  const plans: Array<ProviderPlan> = [];
  for (const canary of selected) {
    const latest: Record<string, string> = {};
    for (const packageName of canary.packageNames) {
      const found = (await fetchDistTags(packageName)).latest;
      if (found) latest[packageName] = found;
    }
    plans.push(planProvider(canary, manifest, after, latest, values.force));
  }
  const include = plans.flatMap((entry) => (entry.kind === "verify" ? [entry.entry] : []));
  const blocked = plans.flatMap((entry) =>
    entry.kind === "blocked"
      ? [{ provider: entry.provider, releases: entry.releases, reason: entry.reason }]
      : [],
  );
  console.log(`Servers newer than styal ${after} receive versions verified now.`);
  for (const entry of plans) {
    if (entry.kind === "blocked")
      console.log(`::warning title=${entry.provider} canary blocked::${entry.reason}`);
    else if (entry.kind === "current") console.log(`${entry.provider}: ${entry.reason}`);
    else
      console.log(
        `${entry.entry.provider}: verify ${entry.entry.packageName}@${entry.entry.version}`,
      );
  }
  const output = { after, matrix: { include }, blocked };
  console.log(JSON.stringify(output));
  if (values.json) NodeFS.writeFileSync(values.json, `${JSON.stringify(output, null, 2)}\n`);
  if (process.env.GITHUB_OUTPUT) {
    NodeFS.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `matrix=${JSON.stringify({ include })}\nhas_work=${include.length > 0}\nafter=${after}\n`,
    );
  }
}

function record(args: ReadonlyArray<string>) {
  const { values } = NodeUtil.parseArgs({
    args: [...args],
    options: {
      after: { type: "string" },
      provider: { type: "string", multiple: true, default: [] },
      package: { type: "string", multiple: true, default: [] },
      version: { type: "string", multiple: true, default: [] },
      pending: { type: "string" },
    },
  });
  const count = values.provider.length;
  if (!values.after || values.package.length !== count || values.version.length !== count) {
    throw new Error("record needs --after and matching --provider, --package and --version.");
  }
  const entries = values.provider.map((provider, index) => ({
    provider,
    packageName: values.package[index]!,
    version: values.version[index]!,
  }));
  const text = NodeFS.readFileSync(MANIFEST_PATH, "utf8");
  const next = recordVersions(
    text,
    values.after,
    entries,
    new Date(),
    readManifest(values.pending),
  );
  if (next === text) {
    console.log("Nothing new to record.");
    return;
  }
  NodeFS.writeFileSync(MANIFEST_PATH, next);
  for (const entry of entries)
    console.log(`Recorded ${entry.packageName}@${entry.version} for styal after ${values.after}`);
}

async function github(path: string, init?: { method: string; body: unknown }) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is not set.");
  const response = await fetch(`https://api.github.com${path}`, {
    method: init?.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
    ...(init ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(`GitHub ${path}: HTTP ${response.status} ${await response.text()}`);
  return response.json() as Promise<unknown>;
}

async function report(args: ReadonlyArray<string>) {
  const { values } = NodeUtil.parseArgs({
    args: [...args],
    options: {
      plan: { type: "string" },
      outcomes: { type: "string" },
      "failed-job": { type: "string", multiple: true, default: [] },
      "run-url": { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo || !values["run-url"]) throw new Error("report needs GITHUB_REPOSITORY and --run-url.");
  const planned =
    values.plan && NodeFS.existsSync(values.plan)
      ? JSON.parse(NodeFS.readFileSync(values.plan, "utf8"))
      : { blocked: [] };
  const outcomes: Array<CanaryOutcome> =
    values.outcomes && NodeFS.existsSync(values.outcomes)
      ? NodeFS.readdirSync(values.outcomes)
          .filter((name) => name.endsWith(".json"))
          .map((name) =>
            JSON.parse(NodeFS.readFileSync(NodePath.join(values.outcomes!, name), "utf8")),
          )
      : [];
  const problems = collectProblems({
    blocked: planned.blocked,
    outcomes,
    failedJobs: values["failed-job"],
  });
  const notes = outcomes
    .filter((outcome) => outcome.outcome === "flaky")
    .map((outcome) => `${outcome.packageName}@${outcome.version}: ${outcome.detail}`);

  const issues = (await github(
    `/repos/${repo}/issues?state=all&creator=${encodeURIComponent("github-actions[bot]")}&per_page=100`,
  )) as Array<{
    number: number;
    state: string;
    title: string;
    body: string | null;
    pull_request?: unknown;
  }>;
  const found = issues.find((issue) => issue.title === STATUS_ISSUE_TITLE && !issue.pull_request);
  const issue = found
    ? { number: found.number, open: found.state === "open", body: found.body ?? "" }
    : null;
  const update = reconcileStatusIssue(issue, problems, notes, values["run-url"]);
  if (update === null) {
    console.log("No canary problems and no open status issue.");
    return;
  }
  if (values["dry-run"]) {
    console.log(`Would ${issue ? `update #${issue.number}` : "open the status issue"}:`);
    console.log(JSON.stringify(update, null, 2));
    return;
  }
  let number = issue?.number;
  if (number === undefined) {
    const created = (await github(`/repos/${repo}/issues`, {
      method: "POST",
      body: {
        title: STATUS_ISSUE_TITLE,
        body: update.body,
        // Assignment notifies the owner even when they do not watch the repository.
        assignees: [repo.split("/")[0]],
      },
    })) as { number: number };
    number = created.number;
    console.log(`Opened status issue #${number}.`);
  } else {
    // Comment before closing so the closing comment is part of the notification.
    if (update.comment && update.state === "closed")
      await github(`/repos/${repo}/issues/${number}/comments`, {
        method: "POST",
        body: { body: update.comment },
      });
    await github(`/repos/${repo}/issues/${number}`, {
      method: "PATCH",
      body: { body: update.body, state: update.state },
    });
    if (update.comment && update.state === "open")
      await github(`/repos/${repo}/issues/${number}/comments`, {
        method: "POST",
        body: { body: update.comment },
      });
    console.log(`Updated status issue #${number} (${update.state}).`);
  }
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "plan") await plan(rest);
  else if (command === "record") record(rest);
  else if (command === "report") await report(rest);
  else {
    console.error(
      "Usage: provider-canary.ts plan [--provider <id>] [--force] [--pending <manifest>] [--json <path>]",
    );
    console.error(
      "       provider-canary.ts record --after <styal> --provider <id> --package <npm> --version <x.y.z> [...] [--pending <manifest>]",
    );
    console.error(
      "       provider-canary.ts report --run-url <url> [--plan <json>] [--outcomes <dir>] [--failed-job <name>] [--dry-run]",
    );
    process.exit(2);
  }
}
