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
const promotionWorkflowPath = NodePath.resolve(
  repoRoot,
  ".github/workflows/promote-upstream-intake.yml",
);
const trackingWorkflowPath = NodePath.resolve(repoRoot, ".github/workflows/upstream-tracking.yml");
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
    commitMessages: ["fix(server): synthetic change\n\nUpstream-PR: 1234"],
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
    assert.include(result.summary, "`pingdotgg/t3code#1234`");
    assert.include(result.summary, "report-only");
  });

  it("blocks missing, malformed, or mismatched upstream provenance", () => {
    const missing = audit({ commitMessages: ["fix(server): no source"] });
    const malformed = audit({ commitMessages: ["Upstream-PR: nope"] });
    const mismatched = audit({ expectedSourcePullRequests: [1235] });

    assert.isFalse(missing.valid);
    assert.include(missing.errors.join("\n"), "no upstream source provenance");
    assert.isFalse(malformed.valid);
    assert.include(malformed.errors.join("\n"), "comma-separated pull request numbers");
    assert.isFalse(mismatched.valid);
    assert.include(mismatched.errors.join("\n"), "do not exactly match");
  });

  it("requires provenance on every candidate commit", () => {
    const result = audit({
      commits: ["b".repeat(40), "c".repeat(40)],
      commitMessages: ["fix(server): sourced\n\nUpstream-PR: 1234", "fix(server): unsourced"],
    });

    assert.isFalse(result.valid);
    assert.include(result.errors.join("\n"), "Candidate commit cccccccccccc");
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
        "apps/server/scripts/publish.ts",
        "packaging/aur/PKGBUILD",
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

  it("gates manual promotion on trusted validation and environment approval", () => {
    const workflow = parse(NodeFS.readFileSync(promotionWorkflowPath, "utf8")) as {
      readonly on: {
        readonly workflow_dispatch: {
          readonly inputs: Record<string, { readonly required: boolean }>;
        };
      };
      readonly permissions: Record<string, string>;
      readonly concurrency: { readonly "cancel-in-progress": boolean };
      readonly jobs: {
        readonly validate: {
          readonly if: string;
          readonly steps: ReadonlyArray<{
            readonly name?: string;
            readonly uses?: string;
            readonly run?: string;
            readonly with?: Record<string, string>;
          }>;
        };
        readonly promote: {
          readonly needs: string;
          readonly environment: string;
          readonly permissions: Record<string, string>;
          readonly steps: ReadonlyArray<{
            readonly name?: string;
            readonly uses?: string;
            readonly run?: string;
            readonly with?: Record<string, string>;
          }>;
        };
      };
    };

    assert.isTrue(workflow.on.workflow_dispatch.inputs.candidate_branch?.required);
    assert.isTrue(workflow.on.workflow_dispatch.inputs.reviewed_sha?.required);
    assert.isTrue(workflow.on.workflow_dispatch.inputs.source_prs?.required);
    assert.equal(workflow.permissions.actions, "read");
    assert.equal(workflow.permissions.contents, "read");
    assert.isFalse(workflow.concurrency["cancel-in-progress"]);
    assert.equal(workflow.jobs.validate.if, "github.repository == 'incognitojam/styal'");

    const trustedCheckout = workflow.jobs.validate.steps.find(
      (step) => step.name === "Checkout trusted promotion code",
    );
    assert.equal(trustedCheckout?.with?.ref, "${{ github.sha }}");

    const resolveCandidate = workflow.jobs.validate.steps.find(
      (step) => step.name === "Resolve the reviewed candidate",
    );
    assert.include(resolveCandidate?.run ?? "", '"$GITHUB_REF" != "refs/heads/main"');
    assert.include(resolveCandidate?.run ?? "", "git check-ref-format");
    assert.include(resolveCandidate?.run ?? "", '"$candidate_sha" != "$REVIEWED_SHA"');
    assert.include(resolveCandidate?.run ?? "", '"$trusted_sha" != "$base_sha"');
    assert.include(
      resolveCandidate?.run ?? "",
      'git diff --quiet "$base_sha" "$candidate_sha" -- .github/workflows/fork-ci.yml',
    );

    const auditCandidate = workflow.jobs.validate.steps.find(
      (step) => step.name === "Audit candidate with trusted main code",
    );
    assert.include(auditCandidate?.run ?? "", "intake:check");
    assert.include(auditCandidate?.run ?? "", '"$EXPECTED_SOURCE_PRS"');

    const verifyCi = workflow.jobs.validate.steps.find(
      (step) => step.name === "Verify Fork CI for the reviewed SHA",
    );
    assert.include(verifyCi?.run ?? "", '--commit "$CANDIDATE_SHA"');
    assert.include(verifyCi?.run ?? "", '"Fork Intake Audit"');
    assert.include(verifyCi?.run ?? "", '"Fork Test (Workspace)"');

    assert.equal(workflow.jobs.promote.needs, "validate");
    assert.equal(workflow.jobs.promote.environment, "upstream-intake-manual");
    assert.equal(workflow.jobs.promote.permissions.actions, "write");
    const tokenStep = workflow.jobs.promote.steps.find(
      (step) => step.name === "Mint Styal Porter token",
    );
    assert.equal(tokenStep?.uses, "actions/create-github-app-token@v2");
    assert.equal(tokenStep?.with?.["permission-contents"], "write");
    assert.equal(tokenStep?.with?.["app-id"], "${{ vars.STYAL_INTAKE_APP_ID }}");

    const promoteStep = workflow.jobs.promote.steps.find(
      (step) => step.name === "Fast-forward main to the reviewed candidate",
    );
    assert.include(promoteStep?.run ?? "", '"$CANDIDATE_SHA" =~ ^[0-9a-f]{40}$');
    assert.include(promoteStep?.run ?? "", '"$current_main_sha" != "$EXPECTED_BASE_SHA"');
    assert.include(promoteStep?.run ?? "", "git merge-base --is-ancestor");
    assert.include(promoteStep?.run ?? "", 'git push origin "${CANDIDATE_SHA}:refs/heads/main"');
    assert.notInclude(promoteStep?.run ?? "", "--force");

    const refreshTracking = workflow.jobs.promote.steps.find(
      (step) => step.name === "Refresh upstream tracking issue",
    );
    assert.include(refreshTracking?.run ?? "", "gh workflow run upstream-tracking.yml");
  });

  it("keeps recovery scans explicit while scheduled tracking uses the weekly window", () => {
    const workflow = parse(NodeFS.readFileSync(trackingWorkflowPath, "utf8")) as {
      readonly on: {
        readonly workflow_dispatch: {
          readonly inputs: { readonly since_days: { readonly default: string } };
        };
      };
      readonly jobs: {
        readonly track: {
          readonly steps: ReadonlyArray<{
            readonly name?: string;
            readonly env?: Record<string, string>;
            readonly run?: string;
          }>;
        };
      };
    };

    assert.equal(workflow.on.workflow_dispatch.inputs.since_days.default, "7");
    const reconcile = workflow.jobs.track.steps.find(
      (step) => step.name === "Reconcile tracking issue",
    );
    assert.include(reconcile?.env?.SINCE_DAYS ?? "", "inputs.since_days");
    assert.include(reconcile?.run ?? "", '--since-days "$SINCE_DAYS"');
  });
});
