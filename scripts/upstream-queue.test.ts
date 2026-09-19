// @effect-diagnostics nodeBuiltinImport:off - Real disposable git histories validate queue boundaries.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";
import {
  advanceBaseline,
  associatePRs,
  decodeState,
  ensureScratchDirectory,
  fetchAssociations,
  formatBatchFooter,
  nextBatch,
  readIntegrations,
  reconcile,
  reconciledThrough,
  shortenCommitSha,
} from "./upstream-queue.ts";
import type { Integration } from "./upstream-queue.ts";

const sha = (n: number) => n.toString(16).padStart(40, "0");
const integration = (n: number, pr: number | null = null): Integration => ({
  sha: sha(n),
  parents: [sha(n - 1)],
  title: `change ${n}`,
  empty: false,
  pr,
});

describe("chronological upstream queue", () => {
  it("asks Git for an unambiguous abbreviated commit SHA", () => {
    const commit = sha(42);
    const calls: [string, string[]][] = [];
    const result = shortenCommitSha(commit, (command, args) => {
      calls.push([command, args]);
      return "0000002a\n";
    });

    assert.equal(result, "0000002a");
    assert.deepEqual(calls, [["git", ["rev-parse", "--short", "--verify", `${commit}^{commit}`]]]);
  });

  it("advances only through fully accounted-for PR boundaries and retains reasoned exceptions", () => {
    const state = {
      upstreamRepository: "example/upstream",
      baseline: sha(0),
      target: sha(4),
      exceptions: {
        [sha(4)]: { disposition: "skip" as const, reason: "Maintained fork behavior." },
      },
    };
    const entries = reconcile(
      [integration(1, 11), integration(2, 11), integration(3, 13), integration(4)],
      [{ sha: sha(20), message: "Upstream-PR: 11" }],
      state.exceptions,
    );
    assert.throws(() => advanceBaseline(state, entries, sha(1)), "middle of a PR");
    assert.throws(() => advanceBaseline(state, entries, sha(4)), "unresolved");
    assert.throws(() => advanceBaseline(state, entries, sha(9)), "outside");
    const advanced = advanceBaseline(state, entries, sha(2));
    assert.equal(advanced.baseline, sha(2));
    assert.equal(state.baseline, sha(0));
    assert.deepEqual(advanced.exceptions, state.exceptions);
  });

  it("can reopen a partial or reverted import without rewriting historic provenance", () => {
    const entries = reconcile(
      [integration(1, 11), integration(2, 11)],
      [{ sha: sha(20), message: "Upstream-PR: 11" }],
      {
        [sha(2)]: {
          disposition: "pending",
          reason: "Historical import omitted this part of the source.",
        },
      },
    );
    assert.deepEqual(
      nextBatch(entries, 1).map((entry) => entry.sha),
      [sha(2)],
    );
    assert.include(entries[1]!.evidence.join("\n"), "Historical import omitted");
  });

  it("does not silently split PRs with interleaved commit associations", () => {
    const entries = reconcile([integration(1, 11), integration(2, 12), integration(3, 11)], [], {});
    assert.throws(() => nextBatch(entries, 1), "interleaved PR");
    assert.equal(nextBatch(entries, 2).length, 3);
  });
  it("requires explicit reasons and full commit boundaries", () => {
    const state = {
      upstreamRepository: "example/upstream",
      baseline: sha(1),
      target: sha(2),
      exceptions: {},
    };
    assert.deepEqual(decodeState(JSON.stringify(state)), state);
    assert.throws(
      () => decodeState(JSON.stringify({ ...state, baseline: "abc" })),
      "Invalid intake state",
    );
    assert.throws(
      () =>
        decodeState(
          JSON.stringify({
            ...state,
            exceptions: { [sha(2)]: { disposition: "skip", reason: " " } },
          }),
        ),
      "Invalid exception",
    );
    assert.throws(
      () =>
        decodeState(
          JSON.stringify({
            ...state,
            exceptions: { "#2": { disposition: "skip", reason: "test" } },
          }),
        ),
      "Invalid exception",
    );
  });

  it("reconciles ancestry, wrapped PR trailers, source sections, commit trailers, and cherry-picks", () => {
    const entries = reconcile(
      [
        integration(1),
        integration(2, 12),
        integration(3, 13),
        integration(4),
        integration(5),
        integration(6, 16),
        integration(7),
      ],
      [
        { sha: sha(1), message: "original" },
        { sha: sha(100), message: "port\n\nUpstream-PR: 12,\n  13\nUpstream-Commit: " + sha(4) },
        { sha: sha(101), message: `(cherry picked from commit ${sha(5)})` },
        { sha: sha(102), message: "Source PRs:\n- `pingdotgg/t3code#16`" },
      ],
      {},
    );
    assert.deepEqual(
      entries.map((entry) => entry.disposition),
      ["recorded", "recorded", "recorded", "recorded", "recorded", "recorded", "pending"],
    );
    assert.include(entries[1]!.evidence[0]!, sha(100));
    assert.equal(reconciledThrough(sha(0), entries), sha(6));
    assert.throws(
      () => reconcile([], [{ sha: sha(10), message: "Upstream-PR: invalid" }], {}),
      "metadata",
    );
  });

  it("keeps partial multi-commit PRs and direct commits visible, and stops the cursor at the first gap", () => {
    const entries = reconcile(
      [integration(1, 11), integration(2, 11), integration(3), integration(4, 14)],
      [{ sha: sha(20), message: `Upstream-Commit: ${sha(1)}\nUpstream-PR: 14` }],
      {},
    );
    assert.deepEqual(
      nextBatch(entries, 1).map((entry) => entry.sha),
      [sha(2), sha(3)],
    );
    assert.equal(reconciledThrough(sha(0), entries), sha(1));
    assert.equal(entries[2]!.disposition, "pending");
  });

  it("selects whole PRs in history order with intervening direct commits and explicit exceptions", () => {
    const entries = reconcile(
      [
        integration(1),
        integration(2, 12),
        integration(3, 12),
        integration(4),
        integration(5, 15),
        integration(6, 16),
      ],
      [],
      {
        [sha(5)]: { disposition: "skip", reason: "Fork supplies the maintained implementation." },
      },
    );
    assert.deepEqual(
      nextBatch(entries, 1).map((entry) => entry.sha),
      [sha(1), sha(2), sha(3), sha(4)],
    );
    assert.equal(entries[4]!.disposition, "skip");
    assert.include(entries[4]!.evidence[0]!, "Fork supplies");
    assert.throws(() => nextBatch(entries, 0), "positive integer");
    assert.throws(() => nextBatch(entries, 1.5), "positive integer");
    assert.deepEqual(nextBatch([], 20), []);
  });

  it("formats copyable provenance for the complete selected batch", () => {
    const entries = reconcile(
      [integration(1, 8321), integration(2, 8321), integration(3), integration(4, 8585)],
      [],
      {},
    );

    assert.equal(
      formatBatchFooter(entries),
      [
        "PR description footer (assumes you incorporate the whole listed batch):",
        "Upstream-PR: 8321, 8585",
        `Upstream-Commit: ${sha(3)}`,
      ].join("\n"),
    );
    assert.equal(
      formatBatchFooter([entries[0]!, entries[1]!, entries[3]!]),
      [
        "PR description footer (assumes you incorporate the whole listed batch):",
        "Upstream-PR: 8321, 8585",
      ].join("\n"),
    );
    assert.equal(
      formatBatchFooter([entries[2]!]),
      [
        "PR description footer (assumes you incorporate the whole listed batch):",
        `Upstream-Commit: ${sha(3)}`,
      ].join("\n"),
    );
    assert.isNull(formatBatchFooter([]));
  });

  it("uses verified merged associations and rejects ambiguous or incomplete PR boundaries", () => {
    const pr = {
      number: 12,
      mergedAt: "2026-01-01",
      baseRefName: "main",
      baseRepository: { nameWithOwner: "example/upstream" },
      mergeCommit: { oid: sha(2) },
    };
    const input = [integration(1), integration(2), integration(3)];
    const cache = { [sha(1)]: [pr], [sha(2)]: [pr], [sha(3)]: [{ ...pr, mergedAt: null }] };
    assert.deepEqual(
      associatePRs(input, cache, "example/upstream", new Set([sha(2)])).map((entry) => entry.pr),
      [12, 12, null],
    );
    assert.throws(
      () => associatePRs(input, cache, "example/upstream", new Set()),
      "outside target",
    );
    assert.throws(() => associatePRs(input, {}, "example/upstream", new Set()), "Missing GitHub");
    assert.throws(
      () =>
        associatePRs(
          [input[0]!],
          { [sha(1)]: [pr, { ...pr, number: 13 }] },
          "example/upstream",
          new Set([sha(2)]),
        ),
      "Ambiguous",
    );
  });

  it("reconciles imports through intermediate branches once their merge commits reach the target", () => {
    const pr = {
      number: 12,
      mergedAt: "2026-01-01",
      baseRefName: "release/cli",
      baseRepository: { nameWithOwner: "example/upstream" },
      mergeCommit: { oid: sha(2) },
    };
    const integrations = [integration(1), integration(2), integration(3)];
    const cache = {
      [sha(1)]: [pr],
      [sha(2)]: [pr],
      [sha(3)]: [{ ...pr, baseRepository: { nameWithOwner: "example/other" } }],
    };
    const associated = associatePRs(integrations, cache, "example/upstream", new Set([sha(2)]));
    assert.deepEqual(
      associated.map((entry) => entry.pr),
      [12, 12, null],
    );
    const entries = reconcile(associated, [{ sha: sha(20), message: "Upstream-PR: 12" }], {});
    assert.deepEqual(
      entries.map((entry) => entry.disposition),
      ["recorded", "recorded", "pending"],
    );
    assert.deepEqual(
      nextBatch(entries, 20).map((entry) => entry.sha),
      [sha(3)],
    );
    assert.throws(
      () => associatePRs(integrations, cache, "example/upstream", new Set()),
      "outside target",
    );
  });

  it("persists fetched PR associations after every batch", () => {
    const integrations = Array.from({ length: 41 }, (_, index) => integration(index + 1));
    const persisted: number[] = [];
    const associations = fetchAssociations(
      integrations,
      "example/upstream",
      {},
      (command, args) => {
        assert.equal(command, "gh");
        const query = args.at(-1)?.replace("query=", "") ?? "";
        const aliases = Array.from(query.matchAll(/c(\d+): object/gu), (match) => match[1]!);
        return JSON.stringify({
          data: {
            repository: Object.fromEntries(
              aliases.map((alias) => [
                `c${alias}`,
                { associatedPullRequests: { nodes: [], pageInfo: { hasNextPage: false } } },
              ]),
            ),
          },
        });
      },
      (cache) => persisted.push(Object.keys(cache).length),
    );

    assert.deepEqual(persisted, [40, 41]);
    assert.equal(Object.keys(associations).length, 41);
  });

  it("walks real first-parent history despite backdated commits, includes merges and empties, and rejects side-branch baselines", () => {
    const root = NodePath.resolve(import.meta.dirname, "..");
    const scratch = ensureScratchDirectory(root);
    const directory = NodeFS.mkdtempSync(NodePath.resolve(scratch, "upstream-queue-test-"));
    const run = (command: string, args: string[]) =>
      NodeChildProcess.execFileSync(
        command,
        [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.test",
          "-c",
          "commit.gpgSign=false",
          "-c",
          "core.hooksPath=/dev/null",
          ...args,
        ],
        {
          cwd: directory,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "Fixture",
            GIT_AUTHOR_EMAIL: "fixture@example.test",
            GIT_COMMITTER_NAME: "Fixture",
            GIT_COMMITTER_EMAIL: "fixture@example.test",
          },
        },
      ).trim();
    const git = (...args: string[]) => run("git", args);
    try {
      git("init", "--initial-branch=main");
      git("config", "core.excludesFile", "/dev/null");
      assert.equal(
        NodeChildProcess.spawnSync("git", ["check-ignore", "-q", ".scratch/"], { cwd: directory })
          .status,
        1,
      );
      ensureScratchDirectory(directory);
      assert.equal(git("check-ignore", ".scratch"), ".scratch");
      const exclude = NodePath.join(directory, ".git/info/exclude");
      const ignoreRules = NodeFS.readFileSync(exclude, "utf8");
      ensureScratchDirectory(directory);
      assert.equal(NodeFS.readFileSync(exclude, "utf8"), ignoreRules);
      assert.isFalse(NodeFS.existsSync(NodePath.join(directory, ".gitignore")));
      git("commit", "--allow-empty", "-m", "base");
      const baseline = git("rev-parse", "HEAD");
      const linkedWorktree = NodePath.join(directory, ".scratch/linked-worktree");
      git("worktree", "add", "--detach", linkedWorktree);
      assert.equal(ensureScratchDirectory(linkedWorktree), NodePath.join(directory, ".scratch"));
      git("checkout", "-b", "side");
      git("commit", "--allow-empty", "-m", "side change");
      const side = git("rev-parse", "HEAD");
      git("checkout", "main");
      git(
        "commit",
        "--allow-empty",
        "--date=2000-01-01T00:00:00Z",
        "-m",
        "backdated direct change",
      );
      const direct = git("rev-parse", "HEAD");
      git("merge", "--no-ff", "side", "-m", "merge side");
      const target = git("rev-parse", "HEAD");
      const state = { upstreamRepository: "example/upstream", baseline, target, exceptions: {} };
      const entries = readIntegrations(state, run);
      assert.deepEqual(
        entries.map((entry) => entry.sha),
        [direct, target],
      );
      assert.equal(entries[1]!.parents.length, 2);
      assert.isTrue(entries[1]!.empty);
      assert.throws(() => readIntegrations({ ...state, baseline: side }, run), "first-parent");
      assert.deepEqual(readIntegrations({ ...state, baseline: target }, run), []);
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});
