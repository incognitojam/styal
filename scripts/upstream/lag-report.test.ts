// @effect-diagnostics nodeBuiltinImport:off - Disposable git histories exercise provisional intake.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { readLagHistory, replayIntake } from "./lag-report.ts";

describe("provisional PR lifecycle", () => {
  it("keeps snapshots out of queue and lag completion until committed tracking cleanup", () => {
    const root = NodePath.resolve(import.meta.dirname, "../..");
    const ignored = NodeChildProcess.spawnSync("git", ["check-ignore", "-q", ".scratch/"], {
      cwd: root,
    });
    if (ignored.status === 1) {
      const exclude = NodeChildProcess.execFileSync(
        "git",
        ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"],
        { cwd: root, encoding: "utf8" },
      ).trim();
      NodeFS.appendFileSync(exclude, "\n/.scratch/\n");
    } else assert.equal(ignored.status, 0);
    NodeFS.mkdirSync(NodePath.join(root, ".scratch"), { recursive: true });
    const directory = NodeFS.mkdtempSync(NodePath.join(root, ".scratch/upstream-snapshot-test-"));
    let clock = 0;
    const run = (command: string, args: string[]) =>
      NodeChildProcess.execFileSync(command, args, {
        cwd: directory,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          PATH: `${NodePath.join(directory, ".scratch/bin")}${NodePath.delimiter}${process.env.PATH}`,
          GIT_AUTHOR_NAME: "Fixture",
          GIT_AUTHOR_EMAIL: "fixture@example.test",
          GIT_COMMITTER_NAME: "Fixture",
          GIT_COMMITTER_EMAIL: "fixture@example.test",
          GIT_AUTHOR_DATE: `@${1_767_225_600 + ++clock} +0000`,
          GIT_COMMITTER_DATE: `@${1_767_225_600 + clock} +0000`,
        },
      }).trim();
    const git = (...args: string[]) =>
      run("git", ["-c", "commit.gpgSign=false", "-c", "core.hooksPath=/dev/null", ...args]);
    const write = (path: string, contents: string) => {
      NodeFS.mkdirSync(NodePath.dirname(NodePath.join(directory, path)), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(directory, path), contents);
    };
    const commit = (message: string) => {
      git("add", ".");
      git("commit", "-m", message);
      return git("rev-parse", "HEAD");
    };
    try {
      git("init", "--initial-branch=upstream");
      write("flow.txt", "base\n");
      write("apps/server/src/persistence/Migrations.ts", "export const migrations = [];\n");
      const base = commit("base");
      git("switch", "-c", "proposal");
      write("flow.txt", "intermediate\n");
      commit("first iteration");
      write("flow.txt", "final\n");
      const head = commit("reviewed proposal");
      git("switch", "upstream");
      git("merge", "--squash", "proposal");
      const integration = commit("final upstream change (#11)");
      git("switch", "-c", "fork", base);
      const statePath = ".github/upstream-intake.json";
      const trackedPath = ".github/upstream-tracked-prs.json";
      write(
        statePath,
        JSON.stringify({
          upstreamRepository: "example/upstream",
          baseline: base,
          target: integration,
          exceptions: {},
        }),
      );
      write(trackedPath, JSON.stringify({ pullRequests: [11] }));
      write("fixture.txt", "synthetic fork invariant\n");
      write("fixture.test.ts", "export {};\n");
      write(
        ".github/fork-features.yml",
        JSON.stringify({
          version: 1,
          fork_repository: "example/fork",
          upstream_repository: "example/upstream",
          coverage: "incremental",
          features: [
            {
              id: "fixture",
              title: "Fixture",
              status: "maintained",
              prs: [],
              invariants: ["Keep fixtures"],
              implementation_paths: ["fixture.txt"],
              upstream_paths: ["fixture.txt"],
              tests: ["fixture.test.ts"],
              upstream: { status: "unassessed", tracking: [], retire_when: "Fixture is removed" },
            },
          ],
        }),
      );
      commit("initial fork policy");
      write(trackedPath, JSON.stringify({ pullRequests: [{ pr: 11 }] }));
      commit("legacy watch entry without a reason");
      write(trackedPath, JSON.stringify({ pullRequests: [{ pr: 11, reason: "Watch change" }] }));
      const forkBase = commit("current watch entry with a reason");
      write("flow.txt", "final\n");
      commit("snapshot import\n\nUpstream-PR: 11");
      write(
        trackedPath,
        JSON.stringify({
          pullRequests: [{ pr: 11, reason: "Reconcile final outcome", snapshot: { base, head } }],
        }),
      );
      const snapshot = commit(
        "record provisional import\n\nFork adaptation: Record the frozen provisional diff for final reconciliation.\n\nUpstream-PR: 11",
      );
      const history = readLagHistory(
        (command, args) => run(command, args),
        "fork",
        "upstream",
        statePath,
      );
      assert.equal(replayIntake(history).steps.at(-1)!.tip, 0);
      assert.deepEqual(replayIntake(history).imports, []);

      // Exercise the real queue CLI without network access, with cached PR associations.
      NodeFS.cpSync(
        NodePath.join(root, "scripts/upstream"),
        NodePath.join(directory, "scripts/upstream"),
        { recursive: true },
      );
      write(".git/info/exclude", "/.scratch/\n/scripts/\n");
      NodeFS.copyFileSync(
        NodePath.join(root, "scripts/fork-feature-ledger.ts"),
        NodePath.join(directory, "scripts/fork-feature-ledger.ts"),
      );
      NodeFS.symlinkSync(
        NodePath.join(root, "scripts/node_modules"),
        NodePath.join(directory, "scripts/node_modules"),
        "dir",
      );
      write(
        ".scratch/bin/gh",
        `#!/usr/bin/env node\nconsole.log(${JSON.stringify(JSON.stringify({ data: { repository: { p0: { number: 11, title: "Proposal", state: "OPEN", mergedAt: null, mergeCommit: null } } } }))});\n`,
      );
      NodeFS.chmodSync(NodePath.join(directory, ".scratch/bin/gh"), 0o755);
      const audit = run(process.execPath, [
        "scripts/upstream/check-intake.ts",
        "--base",
        forkBase,
        "--head",
        snapshot,
        "--upstream-ref",
        "upstream",
      ]);
      assert.include(audit, "Matches upstream.");
      assert.include(audit, "1 of 2 commits differ");
      assert.include(audit, "Manual approval required");
      assert.notInclude(audit, "intermediate");
      write(
        `.scratch/upstream-queue-example-upstream-${integration}-prs.json`,
        JSON.stringify({
          [integration]: [
            {
              number: 11,
              mergedAt: "2026-09-01T00:00:00Z",
              baseRefName: "main",
              baseRepository: { nameWithOwner: "example/upstream" },
              mergeCommit: { oid: integration },
            },
          ],
        }),
      );
      const queue = (...args: string[]) =>
        run(process.execPath, [
          "scripts/upstream/queue.ts",
          ...args,
          "--fork-ref",
          "fork",
          "--upstream-ref",
          "upstream",
        ]);
      const next = JSON.parse(queue("next", "--count", "1", "--json"));
      assert.equal(next.pendingPRs, 1);
      assert.equal(next.entries[0].sha, integration);
      assert.throws(() => queue("advance", integration), "unresolved");
      assert.include(queue("explain", "11"), "Provisional snapshot");

      write(trackedPath, JSON.stringify({ pullRequests: [] }));
      // A draft cleanup cannot affect the queue for the committed fork ref.
      assert.equal(JSON.parse(queue("next", "--count", "1", "--json")).pendingPRs, 1);
      assert.equal(JSON.parse(queue("status", "--json")).tracked[0].snapshot.head, head);
      assert.include(
        run(process.execPath, [
          "scripts/upstream/tracked-prs-report.ts",
          "--fork-ref",
          snapshot,
          "--upstream-ref",
          "upstream",
        ]),
        `snapshot ${head.slice(0, 10)} (provisional)`,
      );
      const cleanup = commit("review identical final change and clear snapshot\n\nUpstream-PR: 11");
      const reconciled = readLagHistory(
        (command, args) => run(command, args),
        "fork",
        "upstream",
        statePath,
      );
      assert.equal(replayIntake(reconciled).steps.at(-1)!.tip, 1);
      assert.deepEqual(
        reconciled.fork.filter((entry) => entry.sources.length).map((entry) => entry.sha),
        [cleanup],
      );
      assert.equal(JSON.parse(queue("next", "--count", "1", "--json")).pendingPRs, 0);
      assert.include(queue("advance", integration), "Baseline advanced");
      assert.equal(
        replayIntake(
          readLagHistory((command, args) => run(command, args), snapshot, "upstream", statePath),
        ).steps.at(-1)!.tip,
        0,
      );

      // A closed import's cleanup must not retroactively record a later reopened merge.
      git("restore", statePath);
      git("switch", "-c", "second-proposal", "upstream");
      write("flow.txt", "second change\n");
      const secondHead = commit("second proposal");
      git("switch", "fork");
      write("flow.txt", "second change\n");
      commit("second snapshot\n\nUpstream-PR: 12");
      const secondTracking = JSON.stringify({
        pullRequests: [
          { pr: 12, reason: "Reconcile", snapshot: { base: integration, head: secondHead } },
        ],
      });
      write(trackedPath, secondTracking);
      commit("track second snapshot\n\nUpstream-PR: 12");
      write(trackedPath, JSON.stringify({ pullRequests: [] }));
      const closed = commit("retain closed import as fork behavior\n\nUpstream-PR: 12");
      git("switch", "upstream");
      git("merge", "--squash", "second-proposal");
      commit("reopened upstream change (#12)");
      git("switch", "fork");
      assert.equal(
        replayIntake(readLagHistory(run, closed, "upstream", statePath)).steps.at(-1)!.tip,
        1,
      );
      write(trackedPath, secondTracking);
      commit("restore marker after reopening\n\nUpstream-PR: 12");
      assert.equal(
        replayIntake(readLagHistory(run, "fork", "upstream", statePath)).steps.at(-1)!.tip,
        1,
      );
      write(trackedPath, JSON.stringify({ pullRequests: [] }));
      commit("reconcile reopened final change\n\nUpstream-PR: 12");
      assert.equal(
        replayIntake(readLagHistory(run, "fork", "upstream", statePath)).steps.at(-1)!.tip,
        2,
      );
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});
