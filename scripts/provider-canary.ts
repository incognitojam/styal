// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalConsole:off globalDate:off preferSchemaOverJson:off
/**
 * Provider canary: decides which provider releases need verification and
 * records verified versions as `autoUpdateVersion` in the model manifest.
 *
 *   node scripts/provider-canary.ts plan [--provider <id>] [--force]
 *   node scripts/provider-canary.ts record --provider <id> --version <x.y.z> [...]
 *
 * `record` takes repeated `--provider`/`--version` pairs. The workflow in
 * .github/workflows/provider-canary.yml runs both around
 * apps/server/scripts/verify-provider-live.ts.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { compareSemverVersions, satisfiesSemverRange } from "@t3tools/shared/semver";

const ROOT = NodePath.resolve(import.meta.dirname, "..");
export const MANIFEST_PATH = NodePath.join(ROOT, "apps/server/src/provider/model-manifest.json");
const SERVER_PACKAGE_PATH = NodePath.join(ROOT, "apps/server/package.json");

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

interface Policy {
  readonly driver: string;
  readonly t3CodeRange: string;
  readonly autoUpdateVersion?: string;
  readonly ranges: ReadonlyArray<{ readonly range: string; readonly status: string }>;
}

interface Manifest {
  readonly updatedAt?: string;
  readonly compatibility?: ReadonlyArray<Policy>;
}

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
  | { readonly kind: "blocked"; readonly provider: string; readonly reason: string };

/**
 * Plans one provider from the npm `latest` version of each of its packages.
 * The newest version in a supported range is verified when it is newer than
 * the recorded `autoUpdateVersion`, or always with `force`.
 */
export function planProvider(
  canary: CanaryProvider,
  manifest: Manifest,
  styalVersion: string,
  latest: Readonly<Record<string, string>>,
  force = false,
): ProviderPlan {
  const index = findPolicyIndex(manifest, canary.provider, styalVersion);
  const policy = manifest.compatibility?.[index];
  if (!policy) {
    return {
      kind: "blocked",
      provider: canary.provider,
      reason: `No ${canary.provider} compatibility policy covers styal ${styalVersion}.`,
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
  const recorded = policy.autoUpdateVersion;
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
  readonly version: string;
}

/**
 * Sets `autoUpdateVersion` on the policies that apply to `styalVersion` and
 * bumps `updatedAt`, editing the text in place so the file keeps its layout.
 * Refuses versions outside a supported range or older than the recorded one.
 */
export function recordVersions(
  text: string,
  styalVersion: string,
  entries: ReadonlyArray<RecordEntry>,
  now: Date,
): string {
  const manifest: Manifest = JSON.parse(text);
  const expected = JSON.parse(text);
  const edits: Array<{ index: number; version: string }> = [];
  for (const { provider, version } of entries) {
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`${provider}: ${version} is not x.y.z.`);
    const index = findPolicyIndex(manifest, provider, styalVersion);
    const policy = manifest.compatibility?.[index];
    if (!policy) throw new Error(`${provider}: no policy covers styal ${styalVersion}.`);
    const status = rangeStatus(policy, version);
    if (status !== "supported") {
      throw new Error(`${provider}: ${version} is ${status}, not in a supported range.`);
    }
    if (policy.autoUpdateVersion && compareSemverVersions(version, policy.autoUpdateVersion) < 0) {
      throw new Error(
        `${provider}: ${version} is older than the recorded ${policy.autoUpdateVersion}.`,
      );
    }
    if (edits.some((edit) => edit.index === index)) {
      throw new Error(`${provider}: recorded more than once.`);
    }
    edits.push({ index, version });
    expected.compatibility[index].autoUpdateVersion = version;
  }

  const updatedAt = now.toISOString();
  if (manifest.updatedAt !== undefined && updatedAt <= manifest.updatedAt) {
    throw new Error(`updatedAt ${updatedAt} is not newer than ${manifest.updatedAt}.`);
  }
  expected.updatedAt = updatedAt;

  const spans = compatibilitySpans(text);
  let next = text;
  // Edit from the end so earlier spans keep their offsets.
  for (const { index, version } of edits.toSorted((left, right) => right.index - left.index)) {
    const span = spans[index]!;
    const body = next.slice(span.start, span.end);
    const existing = /("autoUpdateVersion":\s*)"[^"]*"/;
    let edited: string;
    if (existing.test(body)) {
      edited = body.replace(existing, `$1"${version}"`);
    } else {
      const ranges = /\n([ \t]*)"ranges":/.exec(body);
      if (!ranges) throw new Error("A compatibility policy has no ranges.");
      edited = `${body.slice(0, ranges.index)}\n${ranges[1]}"autoUpdateVersion": "${version}",${body.slice(ranges.index)}`;
    }
    next = next.slice(0, span.start) + edited + next.slice(span.end);
  }
  const stamp = /("updatedAt":\s*)"[^"]*"/;
  next = stamp.test(next)
    ? next.replace(stamp, `$1"${updatedAt}"`)
    : next.replace(/"version":\s*\d+,/, (match) => `${match}\n  "updatedAt": "${updatedAt}",`);

  if (!NodeUtil.isDeepStrictEqual(JSON.parse(next), expected)) {
    throw new Error("Editing the manifest text produced different JSON than intended.");
  }
  return next;
}

async function fetchLatest(packageName: string): Promise<string | undefined> {
  const response = await fetch(
    `https://registry.npmjs.org/-/package/${packageName.replace("/", "%2f")}/dist-tags`,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (response.status === 404) return undefined;
  if (!response.ok)
    throw new Error(`Cannot read ${packageName} dist-tags: HTTP ${response.status}`);
  const tags: unknown = await response.json();
  const latest =
    tags && typeof tags === "object" && "latest" in tags ? Reflect.get(tags, "latest") : undefined;
  return typeof latest === "string" ? latest : undefined;
}

function styalVersion(): string {
  return JSON.parse(NodeFS.readFileSync(SERVER_PACKAGE_PATH, "utf8")).version;
}

async function plan(args: ReadonlyArray<string>) {
  const { values } = NodeUtil.parseArgs({
    args: [...args],
    options: { provider: { type: "string" }, force: { type: "boolean", default: false } },
  });
  const selected = CANARY_PROVIDERS.filter(
    (canary) => !values.provider || canary.provider === values.provider,
  );
  if (selected.length === 0) throw new Error(`Unknown canary provider: ${values.provider}`);
  const manifest: Manifest = JSON.parse(NodeFS.readFileSync(MANIFEST_PATH, "utf8"));
  const version = styalVersion();
  const plans: Array<ProviderPlan> = [];
  for (const canary of selected) {
    const latest: Record<string, string> = {};
    for (const packageName of canary.packageNames) {
      const found = await fetchLatest(packageName);
      if (found) latest[packageName] = found;
    }
    plans.push(planProvider(canary, manifest, version, latest, values.force));
  }
  const include = plans.flatMap((entry) => (entry.kind === "verify" ? [entry.entry] : []));
  const blocked = plans.flatMap((entry) =>
    entry.kind === "blocked" ? [{ provider: entry.provider, reason: entry.reason }] : [],
  );
  for (const entry of plans) {
    if (entry.kind === "blocked")
      console.log(`::warning title=${entry.provider} canary blocked::${entry.reason}`);
    else if (entry.kind === "current") console.log(`${entry.provider}: ${entry.reason}`);
    else
      console.log(
        `${entry.entry.provider}: verify ${entry.entry.packageName}@${entry.entry.version}`,
      );
  }
  const output = { styalVersion: version, matrix: { include }, blocked };
  console.log(JSON.stringify(output));
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
      version: { type: "string", multiple: true, default: [] },
    },
  });
  if (values.provider.length === 0 || values.provider.length !== values.version.length) {
    throw new Error("record needs matching --provider and --version pairs.");
  }
  const entries = values.provider.map((provider, index) => ({
    provider,
    version: values.version[index]!,
  }));
  const text = NodeFS.readFileSync(MANIFEST_PATH, "utf8");
  NodeFS.writeFileSync(MANIFEST_PATH, recordVersions(text, styalVersion(), entries, new Date()));
  for (const entry of entries) console.log(`Recorded ${entry.provider} ${entry.version}`);
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "plan") await plan(rest);
  else if (command === "record") record(rest);
  else {
    console.error("Usage: provider-canary.ts plan [--provider <id>] [--force]");
    console.error("       provider-canary.ts record --provider <id> --version <x.y.z> [...]");
    process.exit(2);
  }
}
