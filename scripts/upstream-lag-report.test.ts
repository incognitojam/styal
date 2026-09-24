// @effect-diagnostics nodeBuiltinImport:off - A disposable git history validates provenance matching.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { readLagHistory, replayIntake, summarizeLag } from "./upstream-lag-report.ts";
import type { LagHistory } from "./upstream-lag-report.ts";
import { ensureScratchDirectory } from "./upstream-queue.ts";

const DAY = 86_400_000;
const base = Date.UTC(2026, 0, 1, 12);
const sha = (n: number) => n.toString(16).padStart(40, "0");

describe("upstream lag report", () => {
  it("separates in-order imports from early ones and measures the gap from the in-order tip", () => {
    const history: LagHistory = {
      upstreamRepository: "example/upstream",
      base: { sha: sha(0), time: base },
      upstream: [1, 2, 3, 4, 5].map((index) => ({
        index,
        sha: sha(index),
        time: base + index * DAY,
        pr: null,
      })),
      fork: [
        { sources: [1], baseline: null },
        { sources: [3], baseline: null },
        { sources: [2, 3], baseline: null },
        { sources: [], baseline: 4 },
      ].map((commit, index) => ({
        ...commit,
        sha: sha(100 + index),
        time: base + (index + 2) * DAY,
        authoredTime: base,
      })),
    };

    const replay = replayIntake(history);
    assert.deepEqual(
      replay.imports.map(({ index, order }) => [index, order]),
      [
        [1, "in order"],
        [3, "early"],
        [2, "in order"],
      ],
    );
    assert.deepEqual(
      replay.steps.map(({ tip, accounted }) => [tip, accounted]),
      [
        [1, 1],
        [1, 2],
        [3, 3],
        [4, 4],
      ],
    );

    const summary = summarizeLag(history, replay, base + 5.25 * DAY);
    assert.deepInclude(summary.current, { upstream: 5, tip: 4, accounted: 4, behind: 1 });
    assert.closeTo(summary.current.ageDays, 1.25, 1e-9);
    // Three in-order integrations against three upstream merges over the window: not converging.
    assert.equal(summary.tipPace, 1);
    assert.equal(summary.upstreamPace, 1);
    assert.isNull(summary.catchUpDays);
    assert.deepEqual(
      summary.days.map(({ merged, inOrder, early }) => [merged, inOrder, early]),
      [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
        [1, 0, 1],
        [1, 1, 0],
        [1, 0, 0],
      ],
    );
  });

  it("matches fork commits to upstream integrations through trailers, cherry-picks, and baseline advances", () => {
    const root = NodePath.resolve(import.meta.dirname, "..");
    const directory = NodeFS.mkdtempSync(
      NodePath.resolve(ensureScratchDirectory(root), "upstream-lag-report-test-"),
    );
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
        { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    const git = (...args: string[]) => run("git", args).trim();
    const commit = (message: string) => {
      git("commit", "--allow-empty", "-m", message);
      return git("rev-parse", "HEAD");
    };
    try {
      git("init", "--initial-branch=main");
      commit("base");
      git("checkout", "-b", "upstream");
      const upstream = [
        "change one (#11)",
        "change two (#12)",
        "direct change",
        "change four (#14)",
      ].map(commit);
      const [one, , direct, four] = upstream;
      git("checkout", "main");
      commit("fork feature");
      commit("intake: change two\n\nUpstream-PR: 12");
      commit(`intake: direct change\n\n(cherry picked from commit ${direct})`);
      const statePath = ".github/upstream-intake.json";
      NodeFS.mkdirSync(NodePath.join(directory, ".github"));
      NodeFS.writeFileSync(
        NodePath.join(directory, statePath),
        JSON.stringify({
          upstreamRepository: "example/upstream",
          baseline: one,
          target: four,
          exceptions: {},
        }),
      );
      git("add", statePath);
      commit(`intake: change four\n\nUpstream-Commit: ${four}`);

      const history = readLagHistory(run, "main", "upstream", statePath);
      assert.equal(history.upstreamRepository, "example/upstream");
      assert.deepEqual(
        history.upstream.map(({ sha }) => sha),
        upstream,
      );
      assert.deepEqual(
        history.upstream.map(({ pr }) => pr),
        [11, 12, null, 14],
      );
      assert.deepEqual(
        history.fork.map(({ sources, baseline }) => [sources, baseline]),
        [
          [[], null],
          [[2], null],
          [[3], null],
          [[4], 1],
        ],
      );
      assert.deepEqual(replayIntake(history).steps.at(-1), {
        time: history.fork.at(-1)!.time,
        tip: 4,
        accounted: 4,
      });
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});
