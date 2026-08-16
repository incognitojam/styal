#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { fromYaml } from "@t3tools/shared/schemaYaml";
import * as Schema from "effect/Schema";

const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0));

const UpstreamDisposition = Schema.Struct({
  status: Schema.Literals(["unassessed", "tracking", "partial", "equivalent"]),
  tracking: Schema.Array(Schema.NonEmptyString),
  retire_when: Schema.NonEmptyString,
});

export const ForkFeatureLedgerEntry = Schema.Struct({
  id: Schema.NonEmptyString,
  title: Schema.NonEmptyString,
  status: Schema.Literals(["maintained", "review-needed", "retiring"]),
  prs: Schema.Array(PositiveInteger),
  invariants: Schema.Array(Schema.NonEmptyString),
  implementation_paths: Schema.Array(Schema.NonEmptyString),
  upstream_paths: Schema.Array(Schema.NonEmptyString),
  tests: Schema.Array(Schema.NonEmptyString),
  upstream: UpstreamDisposition,
});
export type ForkFeatureLedgerEntry = typeof ForkFeatureLedgerEntry.Type;

export const ForkFeatureLedger = Schema.Struct({
  version: Schema.Literal(1),
  coverage: Schema.Literal("incremental"),
  features: Schema.Array(ForkFeatureLedgerEntry),
});
export type ForkFeatureLedger = typeof ForkFeatureLedger.Type;

export interface ForkFeatureOverlap {
  readonly feature: ForkFeatureLedgerEntry;
  readonly paths: ReadonlyArray<string>;
}

export const ledgerRelativePath = ".github/fork-features.yml";
const ledgerSchema = fromYaml(ForkFeatureLedger);

function duplicates<A>(values: ReadonlyArray<A>): ReadonlyArray<A> {
  const seen = new Set<A>();
  const repeated = new Set<A>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated];
}

function isSorted<A extends number | string>(values: ReadonlyArray<A>): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! <= value);
}

function validatePath(
  repoRoot: string,
  featureId: string,
  field: string,
  path: string,
): string | null {
  const segments = path.split("/");
  if (
    NodePath.isAbsolute(path) ||
    path.includes("\\") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return `${featureId}.${field} contains invalid repository path: ${path}`;
  }

  const absolutePath = NodePath.resolve(repoRoot, path);
  const relativePath = NodePath.relative(repoRoot, absolutePath);
  if (relativePath.startsWith("..") || NodePath.isAbsolute(relativePath)) {
    return `${featureId}.${field} escapes the repository: ${path}`;
  }
  if (!NodeFS.existsSync(absolutePath) || !NodeFS.statSync(absolutePath).isFile()) {
    return `${featureId}.${field} does not name an existing file: ${path}`;
  }
  return null;
}

export function decodeForkFeatureLedger(contents: string): ForkFeatureLedger {
  return Schema.decodeUnknownSync(ledgerSchema)(contents);
}

export function validateForkFeatureLedger(
  ledger: ForkFeatureLedger,
  repoRoot: string,
): ReadonlyArray<string> {
  const errors: Array<string> = [];
  const ids = ledger.features.map((feature) => feature.id);

  if (ledger.features.length === 0) errors.push("features must contain at least one entry.");
  if (!isSorted(ids)) errors.push("features must be sorted by id.");
  for (const id of duplicates(ids)) errors.push(`Duplicate feature id: ${id}`);

  for (const feature of ledger.features) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(feature.id)) {
      errors.push(`${feature.id}.id must use lower-kebab-case.`);
    }
    if (feature.prs.length === 0) errors.push(`${feature.id}.prs must not be empty.`);
    if (feature.invariants.length === 0) errors.push(`${feature.id}.invariants must not be empty.`);
    if (feature.implementation_paths.length === 0)
      errors.push(`${feature.id}.implementation_paths must not be empty.`);
    if (feature.tests.length === 0) errors.push(`${feature.id}.tests must not be empty.`);
    if (feature.upstream_paths.length === 0)
      errors.push(`${feature.id}.upstream_paths must not be empty.`);

    for (const [field, values] of [
      ["prs", feature.prs],
      ["implementation_paths", feature.implementation_paths],
      ["tests", feature.tests],
      ["upstream_paths", feature.upstream_paths],
    ] as const) {
      const comparableValues: ReadonlyArray<number | string> = values;
      if (!isSorted(comparableValues)) errors.push(`${feature.id}.${field} must be sorted.`);
      for (const value of duplicates(comparableValues)) {
        errors.push(`${feature.id}.${field} contains duplicate value: ${value}`);
      }
    }

    for (const path of feature.tests) {
      const error = validatePath(repoRoot, feature.id, "tests", path);
      if (error !== null) errors.push(error);
    }
    for (const path of feature.implementation_paths) {
      const error = validatePath(repoRoot, feature.id, "implementation_paths", path);
      if (error !== null) errors.push(error);
    }
    for (const path of feature.upstream_paths) {
      const error = validatePath(repoRoot, feature.id, "upstream_paths", path);
      if (error !== null) errors.push(error);
    }

    for (const trackingUrl of feature.upstream.tracking) {
      try {
        const url = new URL(trackingUrl);
        if (url.protocol !== "https:") throw new Error("not HTTPS");
      } catch {
        errors.push(`${feature.id}.upstream.tracking contains invalid HTTPS URL: ${trackingUrl}`);
      }
    }
    if (!isSorted(feature.upstream.tracking)) {
      errors.push(`${feature.id}.upstream.tracking must be sorted.`);
    }
    for (const trackingUrl of duplicates(feature.upstream.tracking)) {
      errors.push(`${feature.id}.upstream.tracking contains duplicate value: ${trackingUrl}`);
    }
    if (feature.upstream.status === "unassessed" && feature.upstream.tracking.length > 0) {
      errors.push(`${feature.id}.upstream.tracking requires an assessed upstream status.`);
    }
    if (feature.upstream.status !== "unassessed" && feature.upstream.tracking.length === 0) {
      errors.push(`${feature.id}.upstream.tracking must cite evidence for an assessed status.`);
    }
  }

  return errors;
}

export function loadForkFeatureLedger(repoRoot: string): ForkFeatureLedger {
  const ledgerPath = NodePath.resolve(repoRoot, ledgerRelativePath);
  return decodeForkFeatureLedger(NodeFS.readFileSync(ledgerPath, "utf8"));
}

export function findForkFeatureOverlaps(
  ledger: ForkFeatureLedger,
  changedPaths: ReadonlyArray<string>,
): ReadonlyArray<ForkFeatureOverlap> {
  const changed = new Set(changedPaths);
  return ledger.features.flatMap((feature) => {
    const paths = feature.upstream_paths.filter((path) => changed.has(path));
    return paths.length === 0 ? [] : [{ feature, paths }];
  });
}

export function renderForkFeatureOverlapSummary(
  overlaps: ReadonlyArray<ForkFeatureOverlap>,
): string {
  if (overlaps.length === 0) return "No tracked fork feature upstream paths changed.\n";
  const entries = overlaps.map(
    ({ feature, paths }) => `- \`${feature.id}\`: ${feature.title} — ${paths.join(", ")}`,
  );
  return `## Fork feature overlap review\n\n${entries.join("\n")}\n`;
}
