#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Maintainer CI CLI.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import { promotionLane, readNativeChecks } from "./lib/promotion-evidence.ts";

function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const sha = process.env.CANDIDATE_SHA;
  const branch = process.env.CANDIDATE_BRANCH;
  if (
    repository !== "incognitojam/styal" ||
    !sha ||
    !/^[0-9a-f]{40}$/.test(sha) ||
    !branch?.startsWith("intake/")
  ) {
    throw new Error("Expected the fork repository, a full candidate SHA and its intake branch.");
  }
  let nativePassed = false;
  let nativeUrl: string | undefined;
  if (process.env.AUTOMATIC_ELIGIBLE === "true" && process.env.NATIVE_FINGERPRINT !== "unchanged") {
    try {
      const evidence = readNativeChecks(
        (path) =>
          NodeChildProcess.execFileSync(
            "gh",
            ["api", "--paginate", "--slurp", `repos/${repository}/actions/${path}`],
            { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 * 1024 },
          ),
        sha,
        branch,
      );
      nativePassed = evidence.passed;
      nativeUrl = evidence.url;
    } catch (error) {
      console.warn(`Native CI evidence unavailable; require manual approval: ${String(error)}`);
    }
  }
  const { lane, reason } = promotionLane(
    process.env.AUTOMATIC_ELIGIBLE === "true",
    process.env.NATIVE_FINGERPRINT,
    nativePassed,
  );
  if (process.argv.includes("--require-automatic") && lane !== "automatic") {
    throw new Error(`Native eligibility changed; manual approval required. ${reason}`);
  }
  if (process.env.GITHUB_OUTPUT) NodeFS.appendFileSync(process.env.GITHUB_OUTPUT, `lane=${lane}\n`);
  if (process.env.GITHUB_STEP_SUMMARY)
    NodeFS.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `\n## Promotion lane\n\n**${lane}**: ${reason}\n\nNative fingerprint: ${process.env.NATIVE_FINGERPRINT}. Fork macOS and native lint evidence: ${nativePassed ? nativeUrl : "not established"}.\n`,
    );
  console.log(`Promotion lane: ${lane}. ${reason}`);
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
