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

    assert.equal(ledger.coverage, "incremental");
    assert.isAtLeast(ledger.features.length, 6);
    assert.deepEqual(validateForkFeatureLedger(ledger, repoRoot), []);
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
    const first = ledger.features[0]!;
    const second = ledger.features[1]!;
    const invalid = {
      ...ledger,
      features: [
        { ...first, prs: first.prs.toReversed() },
        { ...second, id: first.id },
        ...ledger.features.slice(2),
      ],
    } satisfies ForkFeatureLedger;

    const errors = validate(invalid);

    assert.include(errors, `Duplicate feature id: ${first.id}`);
    assert.include(errors, `${first.id}.prs must be sorted.`);
  });

  it("rejects missing evidence files and unsupported upstream assessments", () => {
    const ledger = loadForkFeatureLedger(repoRoot);
    const first = ledger.features[0]!;
    const invalid = {
      ...ledger,
      features: [
        {
          ...first,
          tests: ["apps/web/src/removed-feature.test.ts"],
          upstream: { ...first.upstream, status: "tracking" as const },
        },
        ...ledger.features.slice(1),
      ],
    } satisfies ForkFeatureLedger;

    const errors = validate(invalid);

    assert.include(errors, `${first.id}.tests does not name an existing file`);
    assert.include(errors, `${first.id}.upstream.tracking must cite evidence`);
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
