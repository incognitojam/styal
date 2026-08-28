// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { assert, describe, it } from "@effect/vitest";
import { parse } from "yaml";

import {
  decodeForkFeatureLedger,
  findForkFeatureOverlaps,
  loadForkFeatureLedger,
  validateForkFeatureLedger,
  type ForkFeatureLedger,
} from "./fork-feature-ledger.ts";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const cliPath = NodePath.resolve(repoRoot, "scripts/check-fork-feature-ledger.ts");
const nightlyWorkflowPath = NodePath.resolve(repoRoot, ".github/workflows/fork-nightly.yml");

function validate(ledger: ForkFeatureLedger): string {
  return validateForkFeatureLedger(ledger, repoRoot).join("\n");
}

describe("fork feature ledger", () => {
  it("keeps the checked-in capability evidence valid", () => {
    const ledger = loadForkFeatureLedger(repoRoot);

    assert.equal(ledger.fork_repository, "incognitojam/styal");
    assert.equal(ledger.upstream_repository, "pingdotgg/t3code");
    assert.equal(ledger.coverage, "incremental");
    assert.isAtLeast(ledger.features.length, 6);
    assert.deepEqual(validateForkFeatureLedger(ledger, repoRoot), []);
  });

  it("rejects invalid or identical repository identities", () => {
    const ledger = loadForkFeatureLedger(repoRoot);

    assert.include(
      validate({ ...ledger, fork_repository: "styal" }),
      "fork_repository must use GitHub owner/name form.",
    );
    assert.include(
      validate({ ...ledger, upstream_repository: ledger.fork_repository }),
      "fork_repository and upstream_repository must be different.",
    );
  });

  it("rejects unsupported ledger versions during decoding", () => {
    assert.throws(() =>
      decodeForkFeatureLedger(`
version: 2
coverage: incremental
features: []
`),
    );
  });

  it("rejects duplicate identities and unsorted evidence", () => {
    const ledger = loadForkFeatureLedger(repoRoot);
    const evidenceIndex = ledger.features.findIndex((feature) => feature.prs.length >= 2);
    assert.isAtLeast(evidenceIndex, 0);
    const evidence = ledger.features[evidenceIndex]!;
    const duplicateIndex = evidenceIndex === 0 ? 1 : 0;
    const invalid = {
      ...ledger,
      features: ledger.features.map((feature, index) => {
        if (index === evidenceIndex) return { ...feature, prs: feature.prs.toReversed() };
        if (index === duplicateIndex) return { ...feature, id: evidence.id };
        return feature;
      }),
    } satisfies ForkFeatureLedger;

    const errors = validate(invalid);

    assert.include(errors, `Duplicate feature id: ${evidence.id}`);
    assert.include(errors, `${evidence.id}.prs must be sorted.`);
  });

  it("rejects missing evidence files and unsupported upstream assessments", () => {
    const ledger = loadForkFeatureLedger(repoRoot);
    const featureIndex = ledger.features.findIndex(
      (feature) => feature.upstream.status === "unassessed",
    );
    assert.isAtLeast(featureIndex, 0);
    const feature = ledger.features[featureIndex]!;
    const invalid = {
      ...ledger,
      features: ledger.features.map((candidate, index) =>
        index === featureIndex
          ? {
              ...candidate,
              tests: ["apps/web/src/removed-feature.test.ts"],
              upstream: { ...candidate.upstream, status: "tracking" as const },
            }
          : candidate,
      ),
    } satisfies ForkFeatureLedger;

    const errors = validate(invalid);

    assert.include(errors, `${feature.id}.tests does not name an existing file`);
    assert.include(errors, `${feature.id}.upstream.tracking must cite evidence`);
  });

  it("maps changed upstream paths to the capabilities needing review", () => {
    const ledger = loadForkFeatureLedger(repoRoot);

    const overlaps = findForkFeatureOverlaps(ledger, [
      "apps/web/src/AppRoot.tsx",
      "apps/web/src/components/sidebar/SidebarChrome.tsx",
      "apps/web/src/untracked.ts",
    ]);

    assert.deepEqual(
      overlaps.map(({ feature, paths }) => ({ id: feature.id, paths })),
      [
        { id: "completion-sounds", paths: ["apps/web/src/AppRoot.tsx"] },
        { id: "first-turn-unread-state", paths: ["apps/web/src/AppRoot.tsx"] },
        {
          id: "github-outage-status",
          paths: ["apps/web/src/components/sidebar/SidebarChrome.tsx"],
        },
      ],
    );
  });

  it("runs the CLI and writes advisory overlap evidence", () => {
    const fixtureRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-ledger-"));
    try {
      const changedPathsFile = NodePath.join(fixtureRoot, "changed-paths.txt");
      const summaryFile = NodePath.join(fixtureRoot, "summary.md");
      NodeFS.writeFileSync(changedPathsFile, "apps/web/src/AppRoot.tsx\n");

      const result = NodeChildProcess.spawnSync(
        process.execPath,
        [cliPath, "--changed-paths", changedPathsFile],
        {
          cwd: repoRoot,
          encoding: "utf8",
          env: { ...process.env, GITHUB_STEP_SUMMARY: summaryFile },
        },
      );

      assert.equal(result.status, 0, result.stderr);
      assert.include(result.stdout, "Validated");
      assert.include(result.stdout, "Upstream touched fork feature::completion-sounds");
      assert.include(NodeFS.readFileSync(summaryFile, "utf8"), "completion-sounds");
    } finally {
      NodeFS.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("wires source-ref-safe advisory overlap review into Fork Nightly", () => {
    const workflow = parse(NodeFS.readFileSync(nightlyWorkflowPath, "utf8")) as {
      readonly jobs: {
        readonly prepare: {
          readonly steps: ReadonlyArray<{
            readonly id?: string;
            readonly name?: string;
            readonly run?: string;
            readonly "continue-on-error"?: boolean;
          }>;
        };
      };
    };
    const candidate = workflow.jobs.prepare.steps.find((step) => step.id === "candidate");
    const review = workflow.jobs.prepare.steps.find(
      (step) => step.name === "Review upstream overlap with fork features",
    );

    assert.include(
      candidate?.run ?? "",
      'old_upstream_ref=$(git merge-base "$main_ref" "$upstream_ref")',
    );
    assert.include(candidate?.run ?? "", 'echo "old_upstream_ref=$old_upstream_ref"');
    assert.notInclude(candidate?.run ?? "", 'echo "old_upstream_ref=$OLD_UPSTREAM_REF"');
    assert.equal(review?.["continue-on-error"], true);
    assert.include(review?.run ?? "", "git diff --name-only --no-renames");
    assert.include(review?.run ?? "", "ledger:check -- --changed-paths");
  });
});
