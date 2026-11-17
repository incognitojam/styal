// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalConsole:off globalDate:off globalJsonInEffect:off
/**
 * Verifies published styal builds, not main: each verification checks out a release tag, so a
 * recorded `autoUpdates` entry names the exact build it passed on. `rewind-plan` instead serves
 * .github/workflows/provider-rewind.yml, which runs the pull request's own code.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as Schema from "effect/Schema";
import { redactCanary } from "./canary-redaction.ts";
import {
  inertText,
  openIssues,
  ensureLabels,
  commentOnce,
  announceIssue,
  type Request,
  type CreatedIssue,
} from "./health-issues.ts";
import { discordPayload, postDiscord } from "./issue-routing.ts";

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
  /** Path prefixes of the provider's own rollback code. */
  readonly rollbackPaths: ReadonlyArray<string>;
}

export const CANARY_PROVIDERS: ReadonlyArray<CanaryProvider> = [
  {
    provider: "codex",
    packageNames: ["@openai/codex"],
    binary: "codex",
    model: "gpt-6-luna",
    secret: "OPENAI_API_KEY",
    rollbackPaths: ["apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts"],
  },
  {
    provider: "claudeAgent",
    packageNames: ["@anthropic-ai/claude-code"],
    binary: "claude",
    model: "claude-haiku-5-5",
    secret: "ANTHROPIC_API_KEY",
    rollbackPaths: [
      "apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts",
      "apps/server/src/orchestration-v2/Adapters/ClaudeHistoryRewind.ts",
    ],
  },
  {
    provider: "opencode",
    packageNames: ["opencode-ai", "@opencode/cli"],
    binary: "opencode",
    // A separate OpenRouter workspace key with its own spending limit.
    model: "openrouter/anthropic/claude-haiku-5.5",
    secret: "OPENROUTER_API_KEY",
    rollbackPaths: ["packages/provider-opencode/src/server/"],
  },
];

/** Path prefixes of rollback code every provider goes through. */
const SHARED_ROLLBACK_PATHS = [
  "apps/server/src/orchestration-v2/CheckpointRollbackService.ts",
  "apps/server/src/orchestration-v2/CheckpointRestoreSafety.ts",
  "apps/server/src/orchestration-v2/ProviderTurnStartService.ts",
  "packages/provider-core/src/server/ProviderAdapter.ts",
  "apps/server/scripts/verify-provider-live.ts",
  "scripts/provider-canary.ts",
  ".github/workflows/provider-rewind.yml",
];

export interface RewindEntry {
  readonly provider: string;
  readonly packageName: string;
  readonly binary: string;
  readonly version: string;
  readonly model: string;
  readonly secret: string;
}

/**
 * Providers a pull request's changed files can break rollback for, each with
 * the release most recently verified on a published build. A pull request
 * builds on main, which contains every published build.
 */
export function planRewind(
  manifest: Manifest,
  changed: ReadonlyArray<string>,
): ReadonlyArray<RewindEntry> {
  const touches = (prefixes: ReadonlyArray<string>) =>
    changed.some((file) => prefixes.some((prefix) => file.startsWith(prefix)));
  const shared = touches(SHARED_ROLLBACK_PATHS);
  return CANARY_PROVIDERS.flatMap((canary) => {
    if (!shared && !touches(canary.rollbackPaths)) return [];
    const newest = (manifest.compatibility ?? [])
      .filter((policy) => policy.driver === canary.provider)
      .flatMap((policy) => policy.autoUpdates ?? [])
      .filter((entry) => canary.packageNames.includes(entry.package))
      .toSorted(
        (left, right) =>
          compareSemverVersions(right.styal, left.styal) ||
          compareSemverVersions(right.version, left.version),
      )[0];
    if (!newest) return [];
    return [
      {
        provider: canary.provider,
        packageName: newest.package,
        binary: canary.binary,
        version: newest.version,
        model: canary.model,
        secret: canary.secret,
      },
    ];
  });
}

export interface AutoUpdateEntry {
  readonly version: string;
  readonly package: string;
  /** The published styal build the canary verified this release on. */
  readonly styal: string;
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

/**
 * Entries kept per package and channel. Older nightly builds are replaced by
 * the desktop app's own updates within days, so their entries stop mattering.
 */
const MAX_ENTRIES_PER_CHANNEL = 3;

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

const isNightly = (version: string) => version.includes("-");

/** Mirrors `styalBuildContains` in apps/server/src/provider/providerCompatibility.ts. */
export function styalBuildContains(version: string, tested: string): boolean {
  if (isNightly(version) || !isNightly(tested)) return compareSemverVersions(version, tested) >= 0;
  return compareSemverVersions(version, tested.slice(0, tested.indexOf("-"))) > 0;
}

/** The version `build` may install for `packageName`, as the server resolves it. */
function verifiedVersion(policy: Policy, packageName: string, build: string): string | undefined {
  let best: string | undefined;
  for (const entry of policy.autoUpdates ?? []) {
    if (entry.package !== packageName || !styalBuildContains(build, entry.styal)) continue;
    if (best === undefined || compareSemverVersions(entry.version, best) > 0) best = entry.version;
  }
  return best;
}

/**
 * Adds a verified release to a policy. An entry is dropped when another one
 * for the same package allows at least its version to every build it covers.
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
    styalBuildContains(narrow.styal, wide.styal);
  const existing = policy.autoUpdates ?? [];
  if (existing.some((other) => covers(other, entry))) return existing;
  const kept = [...existing.filter((other) => !covers(entry, other)), entry];
  const newest = new Set(
    kept
      .filter(
        (other) =>
          other.package === entry.package && isNightly(other.styal) === isNightly(entry.styal),
      )
      .toSorted((left, right) => compareSemverVersions(right.styal, left.styal))
      .slice(0, MAX_ENTRIES_PER_CHANNEL),
  );
  return kept.filter(
    (other) =>
      other.package !== entry.package ||
      isNightly(other.styal) !== isNightly(entry.styal) ||
      newest.has(other),
  );
}

/** An unmerged canary pull request's manifest and the main manifest it was built on. */
export interface PendingManifests {
  readonly pending: Manifest;
  readonly base: Manifest;
}

/**
 * Entries the open canary pull request added that `manifest` lacks. Only the
 * pull request's own additions count, so an entry withdrawn from main since
 * is not brought back.
 */
function pendingEntries(
  manifest: Manifest,
  { pending, base }: PendingManifests,
): Array<{ readonly index: number; readonly entry: AutoUpdateEntry }> {
  const samePolicy = (left: Policy) => (right: Policy) =>
    left.driver === right.driver && left.t3CodeRange === right.t3CodeRange;
  const found: Array<{ index: number; entry: AutoUpdateEntry }> = [];
  for (const policy of pending.compatibility ?? []) {
    const index = (manifest.compatibility ?? []).findIndex(samePolicy(policy));
    if (index === -1) continue;
    const before = (base.compatibility ?? []).find(samePolicy(policy))?.autoUpdates ?? [];
    const known = manifest.compatibility![index]!.autoUpdates ?? [];
    for (const entry of policy.autoUpdates ?? []) {
      const listed = (other: AutoUpdateEntry) => NodeUtil.isDeepStrictEqual(other, entry);
      if (!before.some(listed) && !known.some(listed)) found.push({ index, entry });
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
  /** The styal build to verify against. */
  readonly styal: string;
}

/**
 * A verification that failed twice, kept in the open labeled issue so the next runs
 * do not spend model usage on the same release and build again right away.
 */
export interface CanaryFailure {
  readonly provider: string;
  readonly packageName: string;
  readonly version: string;
  readonly styal: string;
  readonly detail: string;
  /** When it failed, as an ISO timestamp. */
  readonly at: string;
}

/** How long a failed release and build is held back before it is verified again. */
export const FAILURE_RETRY_HOURS = 6;

export type ProviderPlan =
  | { readonly kind: "verify"; readonly provider: string; readonly entry: VerifyEntry }
  | {
      readonly kind: "held";
      readonly provider: string;
      readonly entry: VerifyEntry;
      readonly failure: CanaryFailure;
    }
  | {
      readonly kind: "deferred";
      readonly provider: string;
      readonly reason: string;
      readonly failure?: CanaryFailure;
    }
  | { readonly kind: "current"; readonly provider: string; readonly reason: string }
  | { readonly kind: "blocked"; readonly provider: string; readonly reason: string };

/**
 * The newest supported version is verified when the build may not install it yet, or always with
 * `force`. A release that failed on this build within `FAILURE_RETRY_HOURS` is held unless forced.
 */
export function planProvider(
  canary: CanaryProvider,
  manifest: Manifest,
  build: string,
  latest: Readonly<Record<string, string>>,
  force = false,
  failures: ReadonlyArray<CanaryFailure> = [],
  now = new Date(),
): ProviderPlan {
  const index = findPolicyIndex(manifest, canary.provider, build);
  const policy = manifest.compatibility?.[index];
  if (!policy) {
    return {
      kind: "blocked",
      provider: canary.provider,
      reason: `No ${canary.provider} compatibility policy covers styal ${build}.`,
    };
  }
  const candidates = canary.packageNames
    .flatMap((packageName) => {
      const version = latest[packageName];
      return version && /^\d+\.\d+\.\d+$/.test(version) ? [{ packageName, version }] : [];
    })
    .toSorted((left, right) => compareSemverVersions(right.version, left.version));
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
      reason: `No latest release is in a supported range of the policy for styal ${policy.t3CodeRange} (${described || "no stable release found"}). Review the compatibility ranges.`,
    };
  }
  const recorded = verifiedVersion(policy, supported.packageName, build);
  if (!force && recorded !== undefined && compareSemverVersions(supported.version, recorded) <= 0) {
    return {
      kind: "current",
      provider: canary.provider,
      reason: `${supported.packageName}@${supported.version} is already verified for styal ${build} (${recorded}).`,
    };
  }
  const entry: VerifyEntry = {
    provider: canary.provider,
    packageName: supported.packageName,
    binary: canary.binary,
    version: supported.version,
    model: canary.model,
    secret: canary.secret,
    styal: build,
  };
  const failure = force
    ? undefined
    : failures.find(
        (candidate) =>
          candidate.provider === entry.provider &&
          candidate.packageName === entry.packageName &&
          candidate.version === entry.version &&
          candidate.styal === build &&
          now.getTime() >= Date.parse(candidate.at) &&
          now.getTime() - Date.parse(candidate.at) < FAILURE_RETRY_HOURS * 3_600_000,
      );
  if (failure) return { kind: "held", provider: canary.provider, entry, failure };
  return { kind: "verify", provider: canary.provider, entry };
}

type PackageRelease = { readonly optionalDependencies?: Readonly<Record<string, string>> };

async function fetchPackageRelease(
  packageName: string,
  version: string,
): Promise<PackageRelease | undefined> {
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (response.status === 404) return undefined;
  if (!response.ok)
    throw new Error(`Cannot read ${packageName}@${version}: HTTP ${response.status}`);
  return response.json() as Promise<PackageRelease>;
}

export async function deferUnpublishedPlatforms(
  plan: ProviderPlan,
  read = fetchPackageRelease,
  {
    publishedAt,
    now = new Date(),
  }: { readonly publishedAt?: string | undefined; readonly now?: Date } = {},
): Promise<ProviderPlan> {
  if (plan.kind !== "verify" && plan.kind !== "held") return plan;
  const age = now.getTime() - Date.parse(publishedAt ?? "");
  // After six hours, missing binaries should surface through normal verification failures.
  if (!Number.isFinite(age) || age < 0 || age >= 6 * 3_600_000) return plan;
  const { packageName, version } = plan.entry;
  const release = await read(packageName, version);
  if (release) {
    // The canary runs on Ubuntu x64; other platforms can publish hours later.
    const platform = Object.entries(release.optionalDependencies ?? {}).find(([name]) =>
      name.endsWith("-linux-x64"),
    );
    if (!platform) return plan;
    const [name, dependency] = platform;
    const alias = /^npm:(.+)@([^@]+)$/.exec(dependency);
    const target = alias ? alias[1]! : name;
    const targetVersion = alias ? alias[2]! : dependency;
    if (await read(target, targetVersion)) return plan;
  }
  return {
    kind: "deferred",
    provider: plan.provider,
    ...(plan.kind === "held" ? { failure: plan.failure } : {}),
    reason: `${packageName}@${version} is waiting for its Linux x64 platform package to publish.`,
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
  /** The styal build it was verified on. */
  readonly styal: string;
}

/**
 * Adds verified releases to the policies that apply to the builds they were
 * verified on, plus the open canary pull request's additions, and bumps
 * `updatedAt`. Only the edited `autoUpdates` arrays are rewritten, so the rest
 * of the file keeps its layout. Returns the text unchanged when nothing is new.
 */
export function recordVersions(
  text: string,
  entries: ReadonlyArray<RecordEntry>,
  now: Date,
  pending?: PendingManifests,
): string {
  const manifest: Manifest = JSON.parse(text);
  const policies = [...(manifest.compatibility ?? [])];
  const additions: Array<{ index: number; entry: AutoUpdateEntry }> = [];
  for (const { provider, packageName, version, styal } of entries) {
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`${provider}: ${version} is not x.y.z.`);
    const index = findPolicyIndex(manifest, provider, styal);
    if (index === -1) throw new Error(`${provider}: no policy covers styal ${styal}.`);
    additions.push({ index, entry: { version, package: packageName, styal } });
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

const withoutAutoUpdates = (manifest: Manifest) => ({
  ...manifest,
  updatedAt: undefined,
  compatibility: (manifest.compatibility ?? []).map((policy) => ({
    ...policy,
    autoUpdates: undefined,
  })),
});

/**
 * A canary pull request may merge on its own only when it changes nothing but a forward
 * `updatedAt` and `autoUpdates` arrays that `addAutoUpdate` reproduces exactly from the base,
 * for packages the canary verifies.
 */
export function autoMergeBlocker(baseText: string, headText: string): string | undefined {
  const base: Manifest = JSON.parse(baseText);
  const head: Manifest = JSON.parse(headText);
  if (!NodeUtil.isDeepStrictEqual(withoutAutoUpdates(base), withoutAutoUpdates(head))) {
    return "it changes the model manifest outside `autoUpdates` and `updatedAt`";
  }
  if (head.updatedAt === undefined || (base.updatedAt ?? "") >= head.updatedAt) {
    return "`updatedAt` does not move forward";
  }
  for (const [index, policy] of (base.compatibility ?? []).entries()) {
    const target = head.compatibility![index]!;
    const before = policy.autoUpdates ?? [];
    const after = target.autoUpdates ?? [];
    const added = after.filter(
      (entry) => !before.some((other) => NodeUtil.isDeepStrictEqual(other, entry)),
    );
    const packages =
      CANARY_PROVIDERS.find((canary) => canary.provider === policy.driver)?.packageNames ?? [];
    let replayed = before;
    for (const entry of added) {
      if (
        !packages.includes(entry.package) ||
        !/^\d+\.\d+\.\d+$/.test(entry.version) ||
        !/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(entry.styal)
      ) {
        return `${policy.driver} entry ${JSON.stringify(entry)} is not one the canary records`;
      }
      try {
        replayed = addAutoUpdate({ ...policy, autoUpdates: replayed }, entry);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }
    if (!NodeUtil.isDeepStrictEqual(replayed, after)) {
      return `${policy.driver} \`autoUpdates\` for styal ${policy.t3CodeRange} changes more than recording its new entries would`;
    }
  }
  return undefined;
}

function mergeGuard(args: ReadonlyArray<string>) {
  const { values } = NodeUtil.parseArgs({
    args: [...args],
    options: { base: { type: "string" }, head: { type: "string" } },
  });
  if (!values.base || !values.head) throw new Error("merge-guard needs --base and --head.");
  const blocker = autoMergeBlocker(
    NodeFS.readFileSync(values.base, "utf8"),
    NodeFS.readFileSync(values.head, "utf8"),
  );
  if (blocker) console.log(blocker);
}

/** One verify job's result, written by the workflow. */
export interface CanaryOutcome {
  readonly provider: string;
  readonly packageName: string;
  readonly version: string;
  readonly styal: string;
  /** `flaky` passed on its retry; `skipped` had no credentials. */
  readonly outcome: "passed" | "flaky" | "failed" | "skipped";
  readonly detail: string;
}

export interface CanaryProblem {
  readonly key: string;
  /** The provider id or `job:<name>` whose evaluation can clear it. */
  readonly scope: string;
  readonly summary: string;
  readonly packageName?: string;
  readonly version?: string;
  readonly styal?: string;
}

/** What the plan job wrote; absent when planning failed. */
export interface PlanOutput {
  readonly plans: ReadonlyArray<ProviderPlan & { readonly styal: string }>;
}

type JobResult = "success" | "failure" | "cancelled" | "skipped" | undefined;

/**
 * Problems found in one run, and the scopes this run evaluated. Problems in
 * scopes it did not evaluate, such as other providers on a single-provider
 * dispatch, are left as they were.
 */
export function collectRun(input: {
  readonly plan: PlanOutput | undefined;
  readonly outcomes: ReadonlyArray<CanaryOutcome>;
  readonly planResult: JobResult;
  readonly recordResult: JobResult;
  readonly now?: Date;
}): {
  problems: Array<CanaryProblem>;
  evaluated: Set<string>;
  failures: Array<CanaryFailure>;
  cancelled: boolean;
} {
  const evaluated = new Set<string>();
  const cancelled = input.planResult === "cancelled" || input.recordResult === "cancelled";
  if (cancelled) return { problems: [], evaluated, failures: [], cancelled };
  const failures: Array<CanaryFailure> = [];
  const found = new Map<string, CanaryProblem>();
  const add = (
    key: string,
    scope: string,
    summary: string,
    context?: Pick<CanaryProblem, "packageName" | "version" | "styal">,
  ) => {
    const existing = found.get(key);
    found.set(key, {
      key,
      scope,
      ...(context?.packageName ? { packageName: context.packageName } : {}),
      ...(context?.version ? { version: context.version } : {}),
      ...(context?.styal ? { styal: context.styal } : {}),
      summary: existing ? `${existing.summary} ${summary}` : summary,
    });
  };
  for (const [job, result] of [
    ["plan", input.planResult],
    ["record", input.recordResult],
  ] as const) {
    if (result !== "success" && result !== "failure") continue;
    evaluated.add(`job:${job}`);
    if (result === "failure") add(`job:${job}`, `job:${job}`, "job failed.");
  }
  for (const plan of input.plan?.plans ?? []) {
    const failure = plan.kind === "held" || plan.kind === "deferred" ? plan.failure : undefined;
    if (failure) {
      evaluated.add(plan.provider);
      failures.push(failure);
      add(
        `failed:${failure.provider}:${failure.version}:${failure.styal}`,
        failure.provider,
        failure.detail,
        failure,
      );
      continue;
    }
    if (plan.kind === "deferred") continue;
    evaluated.add(plan.provider);
    if (plan.kind === "blocked") {
      add(`blocked:${plan.provider}:${plan.styal}`, plan.provider, plan.reason, {
        styal: plan.styal,
      });
      continue;
    }
    if (plan.kind !== "verify") continue;
    const { entry } = plan;
    const outcome = input.outcomes.find(
      (candidate) => candidate.provider === entry.provider && candidate.styal === entry.styal,
    );
    if (!outcome)
      add(
        `failed:${entry.provider}:${entry.version}:${entry.styal}`,
        entry.provider,
        "no verification result was saved.",
        entry,
      );
    else if (outcome.outcome === "failed") {
      failures.push({
        provider: entry.provider,
        packageName: entry.packageName,
        version: entry.version,
        styal: entry.styal,
        detail: outcome.detail,
        at: (input.now ?? new Date()).toISOString(),
      });
      add(
        `failed:${entry.provider}:${entry.version}:${entry.styal}`,
        entry.provider,
        `failed verification twice: ${outcome.detail.split(/\r?\n/)[0]}`,
        entry,
      );
    } else if (outcome.outcome === "skipped")
      add(
        `skipped:${entry.provider}:${entry.version}:${entry.styal}`,
        entry.provider,
        `was not verified: ${outcome.detail.split(/\r?\n/)[0]}`,
        entry,
      );
  }
  return { problems: [...found.values()], evaluated, failures, cancelled };
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
  readonly title?: string;
}

function problemBullet(problem: CanaryProblem) {
  const label = [
    `**${inertText(problem.scope, 64)}**`,
    problem.packageName && problem.version
      ? `**${inertText(`${problem.packageName}@${problem.version}`, 210)}**`
      : "",
    problem.styal ? `on styal **${inertText(problem.styal, 80)}**` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `- ${label}: ${inertText(problem.summary)}`;
}

const STATE_MARKER = /<!-- provider-canary-state ([a-f0-9]+) -->/;

const StateString = (limit: number) => Schema.String.check(Schema.isMaxLength(limit));
const StatusState = Schema.Struct({
  problems: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        key: StateString(160),
        scope: StateString(64),
        summary: StateString(200),
        packageName: Schema.optionalKey(StateString(128)),
        version: Schema.optionalKey(StateString(80)),
        styal: Schema.optionalKey(StateString(80)),
      }),
    ).check(Schema.isMaxLength(8)),
  ),
  failures: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        provider: StateString(64),
        packageName: StateString(128),
        version: StateString(80),
        styal: StateString(80),
        at: StateString(32).check(
          Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/),
        ),
      }),
    ).check(Schema.isMaxLength(8)),
  ),
});

const decodeStatusState = Schema.decodeUnknownSync(Schema.fromJsonString(StatusState));

const readStatusState = (
  issue: StatusIssue | null,
  warn: (message: string) => void = (message) => console.warn(message),
): typeof StatusState.Type => {
  if (!issue?.open) return {};
  const marker = STATE_MARKER.exec(issue.body)?.[1];
  if (!marker) {
    if (issue.body.includes("<!-- provider-canary-state"))
      warn("Ignoring malformed provider canary issue state.");
    return {};
  }
  try {
    if (marker.length > 30_000 || marker.length % 2 !== 0)
      throw new Error("Invalid state encoding");
    return decodeStatusState(Buffer.from(marker, "hex").toString("utf8"));
  } catch {
    warn("Ignoring malformed provider canary issue state.");
    return {};
  }
};

/** Failed verifications the open labeled issue still holds back. */
export const statusFailures = (
  issue: StatusIssue | null,
  now = new Date(),
  warn: (message: string) => void = (message) => console.warn(message),
): ReadonlyArray<CanaryFailure> => {
  const state = readStatusState(issue, warn);
  return (state.failures ?? [])
    .filter((failure) => {
      const age = now.getTime() - Date.parse(failure.at);
      if (!Number.isFinite(age) || age < 0) {
        warn("Ignoring provider canary hold with an invalid or future timestamp.");
        return false;
      }
      return age < FAILURE_RETRY_HOURS * 3_600_000;
    })
    .map((failure) => ({
      ...failure,
      detail:
        state.problems?.find(
          (problem) =>
            problem.key === `failed:${failure.provider}:${failure.version}:${failure.styal}`,
        )?.summary ??
        state.problems?.find(
          (problem) => problem.key === `failed:${failure.provider}:${failure.version}`,
        )?.summary ??
        "Failed verification; see original run.",
    }));
};

/**
 * How the labeled issue changes after a run. Problems this run did not
 * evaluate carry over from the open issue. A comment is posted only when a
 * problem appears that the open issue does not list, or when every problem
 * clears and the issue closes. Returns null when nothing changes.
 */
export function reconcileStatusIssue(
  issue: StatusIssue | null,
  run: {
    readonly problems: ReadonlyArray<CanaryProblem>;
    readonly evaluated: ReadonlySet<string>;
    readonly cancelled?: boolean;
    readonly failures?: ReadonlyArray<CanaryFailure>;
  },
  notes: ReadonlyArray<string>,
  runUrl: string,
): StatusIssueUpdate | null {
  if (run.cancelled) return null;
  run = { ...redactCanary({ ...run, evaluated: undefined }), evaluated: run.evaluated };
  notes = redactCanary(notes)
    .slice(0, 4)
    .map((note) => note.slice(0, 300));
  runUrl = redactCanary(runUrl).slice(0, 500);
  const state = redactCanary(readStatusState(issue));
  const previous = state.problems ?? [];
  const problems = [
    ...previous.filter((problem) => !run.evaluated.has(problem.scope)),
    ...run.problems,
  ];
  const failures = [
    ...(state.failures ?? []).filter((failure) => !run.evaluated.has(failure.provider)),
    ...(run.failures ?? []),
  ];
  if (problems.length > 8 || failures.length > 8)
    throw new Error("Canary report exceeds supported problem count");
  const stored = {
    problems: problems.map((p) => ({
      key: p.key.slice(0, 160),
      scope: p.scope.slice(0, 64),
      summary: p.summary.slice(0, 200),
      ...(p.packageName ? { packageName: p.packageName.slice(0, 128) } : {}),
      ...(p.version ? { version: p.version.slice(0, 80) } : {}),
      ...(p.styal ? { styal: p.styal.slice(0, 80) } : {}),
    })),
    ...(failures.length
      ? {
          failures: failures.map((f) => ({
            provider: f.provider.slice(0, 64),
            packageName: f.packageName.slice(0, 128),
            version: f.version.slice(0, 80),
            styal: f.styal.slice(0, 80),
            at: f.at.slice(0, 32),
          })),
        }
      : {}),
  };
  const body = [
    problems.length > 0
      ? "The provider canary found problems that hold back automatic provider updates. This issue is updated on each run and closes when every check passes."
      : `Every provider canary check passed. Recovered at ${new Date().toISOString()}.`,
    problems.map(problemBullet).join("\n"),
    notes.length > 0
      ? `Passed on retry:\n\n${notes.map((note) => `- ${inertText(note)}`).join("\n")}`
      : "",
    `Last run: ${runUrl}`,
    `<!-- provider-canary-state ${Buffer.from(JSON.stringify(stored)).toString("hex")} -->`,
  ]
    .filter(Boolean)
    .join("\n\n");
  if (Buffer.byteLength(body) >= 30_000) throw new Error("Canary report exceeds body budget");
  if (problems.length === 0) {
    return issue?.open
      ? { body, state: "closed", comment: `Every check passed in ${runUrl}. Closing.` }
      : null;
  }
  const identity = (
    items: ReadonlyArray<CanaryProblem>,
    held: ReadonlyArray<Omit<CanaryFailure, "detail">>,
  ) =>
    JSON.stringify(
      items
        .flatMap((problem) => {
          const legacyFailures = held.filter(
            (f) => problem.key === `failed:${f.provider}:${f.version}`,
          );
          const keys = legacyFailures.length
            ? legacyFailures.map((f) => `${problem.key}:${f.styal}`)
            : [problem.key];
          return keys.map((key) => [
            key,
            ...held
              .filter((f) => f.provider === problem.scope)
              .map((f) => `${f.packageName}@${f.version}`)
              .sort(),
          ]);
        })
        .sort(),
    );
  const changed = identity(previous, state.failures ?? []) !== identity(problems, failures);
  return {
    body,
    title: canaryTitle(problems, failures),
    state: "open",
    ...(issue?.open && changed
      ? {
          comment: `Problems changed in ${runUrl}:\n\n${problems.map(problemBullet).join("\n")}`,
        }
      : {}),
  };
}

function canaryTitle(
  problems: ReadonlyArray<CanaryProblem>,
  failures: ReadonlyArray<Omit<CanaryFailure, "detail">>,
) {
  const providers = [...new Set(problems.map((p) => p.scope))];
  const failure = failures.find((f) => providers.includes(f.provider));
  return providers.length > 1
    ? `Provider canary: ${providers.length} providers failing`
    : failure
      ? `Provider canary: ${inertText(failure.provider === "claudeAgent" ? "Claude Code" : failure.provider, 50)} ${inertText(failure.version, 80)} fails verification`
      : `Provider canary: ${inertText(providers[0]!, 80)} needs attention`;
}

export async function syncCanaryReport(options: {
  request: Request;
  repo: string;
  run: Parameters<typeof reconcileStatusIssue>[1];
  notes: ReadonlyArray<string>;
  runUrl: string;
  dryRun: boolean;
  owner?: string;
  announce?: (issue: CreatedIssue) => Promise<void>;
  warn?: (message: string) => void;
}) {
  if (options.run.cancelled) return "Cancelled; no issue changes.";
  const { request, repo, run, notes, runUrl, dryRun } = options;
  const root = `/repos/${repo}`;
  // The retired status issue is never read or changed, even if someone labels it.
  const issues = (await openIssues<StatusIssue>(request, repo, "provider-canary"))
    .filter((issue) => issue.number !== 861)
    .map((issue) => ({ ...issue, open: true }));
  const targets = issues.length ? issues : [null];
  const actions: string[] = [];
  for (const issue of targets) {
    const update = reconcileStatusIssue(issue, run, notes, runUrl);
    if (!update) continue;
    if (issue) {
      const action = update.state === "closed" ? "close" : update.comment ? "comment" : "keep";
      actions.push(`would ${action} #${issue.number}`);
      if (dryRun) continue;
      if (update.state === "closed") {
        await request("PATCH", `${root}/issues/${issue.number}`, { body: update.body });
        await commentOnce(
          request,
          root,
          issue.number,
          `${update.comment}\n\n<!-- provider-canary-recovered -->`,
          "<!-- provider-canary-recovered -->",
        );
        await request("PATCH", `${root}/issues/${issue.number}`, {
          state: "closed",
          state_reason: "completed",
        });
      } else {
        if (update.comment) await commentOnce(request, root, issue.number, update.comment);
        await request("PATCH", `${root}/issues/${issue.number}`, {
          body: update.body,
          ...(update.comment ? { title: update.title } : {}),
        });
      }
    } else {
      const title = update.title!;
      actions.push(
        `would open: ${title}\n${update.body
          .split("\n")
          .filter((line) => !line.startsWith("<!--"))
          .join("\n")}`,
      );
      if (dryRun) continue;
      await ensureLabels(request, root, [
        {
          name: "provider-canary",
          color: "b60205",
          description: "Provider canary problems; closes on recovery.",
        },
        { name: "bug", color: "d73a4a", description: "Something isn't working" },
      ]);
      const created = await request<CreatedIssue>("POST", `${root}/issues`, {
        title,
        body: update.body,
        labels: ["provider-canary", "bug"],
      });
      if (options.owner) {
        try {
          await request("POST", `${root}/issues/${created.number}/assignees`, {
            assignees: [options.owner],
          });
        } catch {
          options.warn?.("Canary issue opened, but repository owner assignment failed.");
        }
      }
      await announceIssue(created, options.announce, options.warn);
    }
  }
  return actions.join("\n") || "No canary problems and no open issue.";
}

type PackageMetadata = {
  readonly "dist-tags"?: Readonly<Record<string, string>>;
  readonly time?: Readonly<Record<string, string>>;
};

async function fetchPackageMetadata(packageName: string): Promise<PackageMetadata> {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) return {};
  if (!response.ok) throw new Error(`Cannot read ${packageName} metadata: HTTP ${response.status}`);
  return response.json() as Promise<PackageMetadata>;
}

export function selectNightlyBuilds(
  latest: string | undefined,
  publishedAt: Readonly<Record<string, string>>,
  now: Date,
): ReadonlyArray<string> {
  if (!latest) return [];
  const cutoff = now.getTime() - 7 * 24 * 60 * 60 * 1_000;
  const baseline = Object.entries(publishedAt)
    .filter(([version, date]) => {
      const timestamp = Date.parse(date);
      return (
        /^\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/.test(version) &&
        timestamp >= cutoff &&
        timestamp <= now.getTime() &&
        compareSemverVersions(version, latest) < 0
      );
    })
    .map(([version]) => version)
    .toSorted(compareSemverVersions)[0];
  return baseline ? [latest, baseline] : [latest];
}

/** Published builds whose tags contain the verifier. */
async function publishedBuilds(): Promise<Array<{ styal: string; ref: string }>> {
  const response = await fetch("https://registry.npmjs.org/@styal%2fcli", {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Cannot read @styal/cli publications: HTTP ${response.status}`);
  const metadata = (await response.json()) as {
    "dist-tags": Record<string, string>;
    time: Record<string, string>;
  };
  const builds: Array<{ styal: string; ref: string }> = [];
  for (const styal of selectNightlyBuilds(
    metadata["dist-tags"].nightly,
    metadata.time,
    new Date(),
  )) {
    const ref = `v${styal}`;
    const git = (...args: Array<string>) =>
      NodeChildProcess.spawnSync("git", args, { cwd: ROOT, stdio: "ignore" }).status === 0;
    if (
      !git(
        "fetch",
        "--quiet",
        "--no-tags",
        "--depth=1",
        "origin",
        `refs/tags/${ref}:refs/tags/${ref}`,
      )
    )
      throw new Error(`Cannot fetch the ${ref} tag.`);
    if (!git("cat-file", "-e", `${ref}:apps/server/scripts/verify-provider-live.ts`)) {
      console.log(`styal ${styal} predates the provider canary; skipping it.`);
      continue;
    }
    builds.push({ styal, ref });
  }
  return builds;
}

function readJson<A>(path: string | undefined): A | undefined {
  return path && NodeFS.existsSync(path)
    ? JSON.parse(NodeFS.readFileSync(path, "utf8"))
    : undefined;
}

function readPending(
  pendingPath: string | undefined,
  basePath: string | undefined,
): PendingManifests | undefined {
  const pending = readJson<Manifest>(pendingPath);
  const base = readJson<Manifest>(basePath);
  return pending && base ? { pending, base } : undefined;
}

async function plan(args: ReadonlyArray<string>) {
  const { values } = NodeUtil.parseArgs({
    args: [...args],
    options: {
      provider: { type: "string" },
      force: { type: "boolean", default: false },
      build: { type: "string", multiple: true, default: [] },
      pending: { type: "string" },
      "pending-base": { type: "string" },
      json: { type: "string" },
    },
  });
  const selected = CANARY_PROVIDERS.filter(
    (canary) => !values.provider || canary.provider === values.provider,
  );
  if (selected.length === 0) throw new Error(`Unknown canary provider: ${values.provider}`);
  const builds =
    values.build.length > 0
      ? values.build.map((value) => {
          const [styal = "", ref = ""] = value.split("=");
          if (!styal || !ref) throw new Error(`--build needs <version>=<ref>, got ${value}.`);
          return { styal, ref };
        })
      : await publishedBuilds();
  const text = NodeFS.readFileSync(MANIFEST_PATH, "utf8");
  const pending = readPending(values.pending, values["pending-base"]);
  // Plan against what main will hold once the open canary pull request merges.
  const manifest: Manifest = JSON.parse(
    pending ? recordVersions(text, [], new Date(), pending) : text,
  );
  // Without GitHub access, as when run locally, no failure is held back.
  const repo = process.env.GITHUB_REPOSITORY;
  const failures = repo && process.env.GITHUB_TOKEN ? await findStatusFailures(repo) : [];
  const now = new Date();
  const plans: Array<ProviderPlan & { styal: string }> = [];
  const include: Array<VerifyEntry & { ref: string }> = [];
  for (const canary of selected) {
    const latest: Record<string, string> = {};
    const publications: Record<string, Readonly<Record<string, string>>> = {};
    for (const packageName of canary.packageNames) {
      const metadata = await fetchPackageMetadata(packageName);
      const found = metadata["dist-tags"]?.latest;
      if (found) latest[packageName] = found;
      publications[packageName] = metadata.time ?? {};
    }
    for (const { styal, ref } of builds) {
      const candidate = planProvider(canary, manifest, styal, latest, values.force, failures, now);
      const publishedAt =
        candidate.kind === "verify" || candidate.kind === "held"
          ? publications[candidate.entry.packageName]?.[candidate.entry.version]
          : undefined;
      const planned = await deferUnpublishedPlatforms(candidate, fetchPackageRelease, {
        publishedAt,
        now,
      });
      plans.push({ ...planned, styal });
      if (planned.kind === "verify") include.push({ ...planned.entry, ref });
      if (planned.kind === "blocked")
        console.log(`::warning title=${canary.provider} canary blocked::${planned.reason}`);
      else if (planned.kind === "current" || planned.kind === "deferred")
        console.log(`${canary.provider}: ${planned.reason}`);
      else if (planned.kind === "held")
        console.log(
          `${canary.provider}: ${planned.entry.packageName}@${planned.entry.version} failed on styal ${styal} at ${planned.failure.at}; not verifying it again yet.`,
        );
      else
        console.log(
          `${canary.provider}: verify ${planned.entry.packageName}@${planned.entry.version} on styal ${styal}`,
        );
    }
  }
  const output = { plans, matrix: { include } };
  if (values.json) NodeFS.writeFileSync(values.json, `${JSON.stringify(output, null, 2)}\n`);
  if (process.env.GITHUB_OUTPUT) {
    NodeFS.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `matrix=${JSON.stringify({ include })}\nhas_work=${include.length > 0}\n`,
    );
  }
}

function record(args: ReadonlyArray<string>) {
  const { values } = NodeUtil.parseArgs({
    args: [...args],
    options: {
      provider: { type: "string", multiple: true, default: [] },
      package: { type: "string", multiple: true, default: [] },
      version: { type: "string", multiple: true, default: [] },
      styal: { type: "string", multiple: true, default: [] },
      pending: { type: "string" },
      "pending-base": { type: "string" },
    },
  });
  const count = values.provider.length;
  if ([values.package, values.version, values.styal].some((list) => list.length !== count)) {
    throw new Error("record needs matching --provider, --package, --version and --styal.");
  }
  const entries = values.provider.map((provider, index) => ({
    provider,
    packageName: values.package[index]!,
    version: values.version[index]!,
    styal: values.styal[index]!,
  }));
  const text = NodeFS.readFileSync(MANIFEST_PATH, "utf8");
  const next = recordVersions(
    text,
    entries,
    new Date(),
    readPending(values.pending, values["pending-base"]),
  );
  if (next === text) {
    console.log("Nothing new to record.");
    return;
  }
  NodeFS.writeFileSync(MANIFEST_PATH, next);
  for (const entry of entries)
    console.log(`Recorded ${entry.packageName}@${entry.version} for styal ${entry.styal}`);
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
    throw Object.assign(new Error(`GitHub ${path}: HTTP ${response.status}`), {
      status: response.status,
    });
  return response.json() as Promise<unknown>;
}

async function findStatusFailures(repo: string): Promise<ReadonlyArray<CanaryFailure>> {
  const issues = await openIssues<StatusIssue>(githubRequest, repo, "provider-canary");
  return issues
    .filter((issue) => issue.number !== 861)
    .flatMap((issue) => statusFailures({ ...issue, open: true }));
}

const githubRequest: Request = async <T>(method: string, path: string, body?: object) =>
  (await github(path, method === "GET" ? undefined : { method, body })) as T;

async function report(args: ReadonlyArray<string>) {
  const { values } = NodeUtil.parseArgs({
    args: [...args],
    options: {
      plan: { type: "string" },
      outcomes: { type: "string" },
      "plan-result": { type: "string" },
      "record-result": { type: "string" },
      "run-url": { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo || !values["run-url"]) throw new Error("report needs GITHUB_REPOSITORY and --run-url.");
  const outcomesDir = values.outcomes;
  const outcomes: Array<CanaryOutcome> =
    outcomesDir && NodeFS.existsSync(outcomesDir)
      ? NodeFS.readdirSync(outcomesDir)
          .filter((name) => name.endsWith(".json"))
          .map((name) => JSON.parse(NodeFS.readFileSync(NodePath.join(outcomesDir, name), "utf8")))
      : [];
  const run = collectRun({
    plan: readJson<PlanOutput>(values.plan),
    outcomes,
    planResult: values["plan-result"] as JobResult,
    recordResult: values["record-result"] as JobResult,
  });
  const notes = outcomes
    .filter((outcome) => outcome.outcome === "flaky")
    .map(
      (outcome) =>
        `${outcome.packageName}@${outcome.version} on styal ${outcome.styal}: ${outcome.detail.split(/\r?\n/)[0]}`,
    );

  const manifest = readJson<Manifest>(MANIFEST_PATH);
  const enriched = {
    ...run,
    problems: run.problems.map((problem) => {
      const passed = manifest?.compatibility
        ?.filter((p) => p.driver === problem.scope)
        .flatMap((p) => p.autoUpdates ?? [])
        .toSorted((a, b) => compareSemverVersions(b.version, a.version))[0];
      return {
        ...problem,
        summary: `${problem.summary}${passed ? ` Last version passed: ${passed.version}.` : ""}`,
      };
    }),
  };
  console.log(
    await syncCanaryReport({
      request: githubRequest,
      repo,
      run: enriched,
      notes,
      runUrl: values["run-url"],
      dryRun: values["dry-run"],
      ...(process.env.REPOSITORY_OWNER ? { owner: process.env.REPOSITORY_OWNER } : {}),
      warn: (message) => console.warn(`::warning::${message}`),
      announce: async (issue) => {
        const webhook = process.env.DISCORD_WEBHOOK_URL;
        if (webhook && !(await postDiscord(webhook, discordPayload(issue, "other"))))
          throw new Error("Discord delivery failed");
      },
    }),
  );
}

function rewindPlan(args: ReadonlyArray<string>) {
  const { values } = NodeUtil.parseArgs({
    args: [...args],
    options: { changed: { type: "string" }, json: { type: "string" } },
  });
  if (!values.changed) throw new Error("rewind-plan needs --changed <file list>.");
  const changed = NodeFS.readFileSync(values.changed, "utf8").split("\n").filter(Boolean);
  const manifest = readJson<Manifest>(MANIFEST_PATH)!;
  const matrix = planRewind(manifest, changed);
  for (const entry of matrix)
    console.log(`${entry.provider}: ${entry.packageName}@${entry.version} with ${entry.model}`);
  if (matrix.length === 0) console.log("No provider's rollback code changed.");
  if (values.json) NodeFS.writeFileSync(values.json, JSON.stringify({ include: matrix }));
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "plan") await plan(rest);
  else if (command === "record") record(rest);
  else if (command === "report") await report(rest);
  else if (command === "merge-guard") mergeGuard(rest);
  else if (command === "rewind-plan") rewindPlan(rest);
  else {
    console.error("Usage: see the comment at the top of scripts/provider-canary.ts.");
    process.exit(2);
  }
}
