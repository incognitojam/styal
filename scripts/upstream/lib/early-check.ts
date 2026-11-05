// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { verify, type VerificationResult } from "../intake-run.ts";

export function failureSignatures(results: readonly VerificationResult[]): string[] {
  return results
    .filter((step) => !step.ok)
    .flatMap((step) => {
      const files = [...step.output.matchAll(/FAIL\s+([^\n]*?\.test\.tsx?)/gu)].map((match) =>
        match[1]!.trim(),
      );
      const name = step.name.replace(/ \(\d+ related files?\)$/u, "");
      return files.length ? [...new Set(files)].map((file) => `${name}: ${file}`) : [name];
    });
}

export async function checkEarlyTree(input: {
  root: string;
  scratch: string;
  objectDirectory: string;
  head: string;
  base: string;
  env?: NodeJS.ProcessEnv;
}) {
  const directory = NodeFS.mkdtempSync(NodePath.join(input.scratch, "early-check-"));
  const env = { ...(input.env ?? process.env) };
  // A repository-local temp directory changes git fixture discovery and creates false failures.
  delete env.TMPDIR;
  delete env.TMP;
  delete env.TEMP;
  delete env.GIT_OBJECT_DIRECTORY;
  delete env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  const git = (args: string[]) =>
    NodeChildProcess.execFileSync("git", args, {
      cwd: directory,
      env,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  try {
    git(["clone", "--quiet", "--shared", "--no-checkout", input.root, "."]);
    NodeFS.appendFileSync(
      NodePath.join(directory, ".git/objects/info/alternates"),
      `\n${input.objectDirectory}\n`,
    );
    git(["sparse-checkout", "set", "--no-cone", "/*", "!/.repos/"]);
    git(["checkout", "--quiet", "--detach", input.head]);
    const changedPaths = git([
      "diff",
      "--name-only",
      "--no-renames",
      `${input.base}...${input.head}`,
    ])
      .split("\n")
      .filter(Boolean);
    const run = async () => {
      let results: readonly VerificationResult[] = [];
      // The verifier is imported from the caller, but every command runs against this merged tree.
      await verify(directory, input.base, {
        changedPaths,
        quiet: true,
        env,
        onResults: (value) => {
          results = value;
        },
      });
      return results;
    };
    process.stderr.write("Checking simulated merged tree...\n");
    const candidate = await run();
    const failures = failureSignatures(candidate);
    if (!failures.length) return { status: "passed", failures: [], baselineFailures: [] };
    git(["checkout", "--quiet", "--force", "--detach", input.base]);
    process.stderr.write("Rerunning failed verification on the base...\n");
    const baseline = await run();
    const baselineFailures = failureSignatures(baseline);
    const introduced = failures.filter((failure) => !baselineFailures.includes(failure));
    return {
      status: introduced.length ? "failed" : "baseline-failed",
      failures,
      baselineFailures,
      introduced,
      candidateDetails: candidate.filter((step) => !step.ok),
      baselineDetails: baseline.filter((step) => !step.ok),
    };
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
}
