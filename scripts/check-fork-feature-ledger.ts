#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  findForkFeatureOverlaps,
  loadForkFeatureLedger,
  renderForkFeatureOverlapSummary,
  validateForkFeatureLedger,
} from "./fork-feature-ledger.ts";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

try {
  const ledger = loadForkFeatureLedger(repoRoot);
  const errors = validateForkFeatureLedger(ledger, repoRoot);
  if (errors.length > 0) {
    process.stderr.write(`${errors.map((error) => `- ${error}`).join("\n")}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`Validated ${ledger.features.length} fork feature ledger entries.\n`);
    const changedPathsFlagIndex = process.argv.indexOf("--changed-paths");
    if (changedPathsFlagIndex !== -1) {
      const changedPathsFile = process.argv[changedPathsFlagIndex + 1];
      if (changedPathsFile === undefined) throw new Error("--changed-paths requires a file path.");
      const changedPaths = NodeFS.readFileSync(changedPathsFile, "utf8")
        .split(/\r?\n/u)
        .filter((path) => path.length > 0);
      const overlaps = findForkFeatureOverlaps(ledger, changedPaths);
      const summary = renderForkFeatureOverlapSummary(overlaps);
      process.stdout.write(summary);
      if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
        NodeFS.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
      }
      for (const { feature, paths } of overlaps) {
        process.stdout.write(
          `::warning title=Changed path overlaps fork feature::${feature.id}: ${paths.join(", ")}\n`,
        );
      }
    }
  }
} catch (error) {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
}
