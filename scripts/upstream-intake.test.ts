// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { assert, describe, it } from "@effect/vitest";
import { parse } from "yaml";

import type { ForkFeatureLedger } from "./fork-feature-ledger.ts";
import { auditUpstreamIntakeCandidate } from "./upstream-intake.ts";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const ciWorkflowPath = NodePath.resolve(repoRoot, ".github/workflows/fork-ci.yml");
const ledger = {
  version: 1,
  fork_repository: "example/fork",
  upstream_repository: "example/upstream",
  coverage: "incremental",
  features: [
    {
      id: "watched-capability",
      title: "Synthetic watched capability",
      status: "maintained",
      prs: [1],
      invariants: ["The watched behavior remains intact."],
      implementation_paths: ["apps/web/src/AppRoot.tsx"],
      upstream_paths: ["apps/web/src/AppRoot.tsx"],
      tests: ["apps/web/src/AppRoot.test.tsx"],
      upstream: {
        status: "unassessed",
        tracking: [],
        retire_when: "The synthetic behavior is no longer maintained.",
      },
    },
  ],
} satisfies ForkFeatureLedger;

function audit(overrides: Partial<Parameters<typeof auditUpstreamIntakeCandidate>[0]> = {}) {
  return auditUpstreamIntakeCandidate({
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    commits: ["b".repeat(40)],
    mergeCommits: [],
    mainIsAncestor: true,
    changedPaths: ["apps/server/src/usage/usageReports.ts"],
    ledger,
    ...overrides,
  });
}

describe("upstream intake audit", () => {
  it("marks a structurally valid low-risk candidate as automatically eligible", () => {
    const result = audit();

    assert.isTrue(result.valid);
    assert.isTrue(result.automaticEligible);
    assert.deepEqual(result.manualReviewReasons, []);
    assert.include(result.summary, "Eligible for automatic promotion");
    assert.include(result.summary, "report-only");
  });

  it("requires manual review for sensitive paths and fork feature overlap", () => {
    const result = audit({
      changedPaths: [
        ".github/workflows/fork-ci.yml",
        "apps/server/src/auth/EnvironmentAuth.ts",
        "apps/server/src/persistence/Migrations/043_ProjectionThreadsUnsettledAt.ts",
        "apps/web/src/AppRoot.tsx",
        "packages/contracts/src/auth.ts",
        "pnpm-lock.yaml",
        "scripts/release-smoke.ts",
      ],
    });

    assert.isTrue(result.valid);
    assert.isFalse(result.automaticEligible);
    assert.include(
      result.manualReviewReasons,
      "repository automation or maintainer policy changed",
    );
    assert.include(result.manualReviewReasons, "dependency or build configuration changed");
    assert.include(result.manualReviewReasons, "a database migration changed");
    assert.include(result.manualReviewReasons, "authentication or authorization code changed");
    assert.include(result.manualReviewReasons, "a cross-surface contract changed");
    assert.include(
      result.manualReviewReasons,
      "a user-facing client changed and needs surface-specific review",
    );
    assert.deepEqual(result.overlapFeatureIds, ["watched-capability"]);
    assert.include(result.summary, "Manual approval required");
  });

  it("blocks candidates that cannot be fast-forwarded or contain merges", () => {
    const result = audit({
      mainIsAncestor: false,
      mergeCommits: ["c".repeat(40)],
    });

    assert.isFalse(result.valid);
    assert.isFalse(result.automaticEligible);
    assert.include(result.errors, "The candidate is not a fast-forward of main.");
    assert.include(result.errors.join("\n"), "contains merge commits");
    assert.include(result.summary, "Blocked");
  });

  it("runs Fork CI and the intake audit for intake branches", () => {
    const workflow = parse(NodeFS.readFileSync(ciWorkflowPath, "utf8")) as {
      readonly concurrency: { readonly group: string; readonly "cancel-in-progress": string };
      readonly on: {
        readonly push: { readonly branches: ReadonlyArray<string> };
      };
      readonly jobs: {
        readonly intake: {
          readonly name: string;
          readonly if: string;
          readonly steps: ReadonlyArray<{ readonly name?: string; readonly run?: string }>;
        };
      };
    };

    assert.include(workflow.on.push.branches, "intake/**");
    assert.include(workflow.concurrency.group, "github.ref");
    assert.include(workflow.concurrency["cancel-in-progress"], "refs/heads/intake/");
    assert.equal(workflow.jobs.intake.name, "Fork Intake Audit");
    assert.include(workflow.jobs.intake.if, "refs/heads/intake/");
    assert.include(workflow.jobs.intake.if, "incognitojam/styal");
    const auditStep = workflow.jobs.intake.steps.find(
      (step) => step.name === "Audit upstream intake candidate",
    );
    assert.include(auditStep?.run ?? "", "intake:check");
    assert.include(auditStep?.run ?? "", "refs/remotes/origin/main");
    assert.include(auditStep?.run ?? "", '"$GITHUB_SHA"');
  });
});
