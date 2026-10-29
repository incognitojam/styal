#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off

import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { findRepositoryUpstreamNames } from "./upstream-naming.ts";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

const findings = findRepositoryUpstreamNames(repoRoot);
if (findings.length === 0) {
  process.stdout.write("No upstream product names in user- or agent-facing strings.\n");
} else {
  for (const { path, line, name, text } of findings) {
    process.stdout.write(
      `::error file=${path},line=${line},title=Upstream product name::${name}\n`,
    );
    process.stderr.write(`${path}:${line}: ${text}\n`);
  }
  process.stderr.write(
    `\n${findings.length} string(s) name the upstream product. Use styal or styal Link, or add the file to UPSTREAM_NAMING_EXCEPTIONS in scripts/upstream-naming.ts with the reason.\n`,
  );
  process.exitCode = 1;
}
