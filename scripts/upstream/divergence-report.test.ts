// @effect-diagnostics nodeBuiltinImport:off - Real disposable git histories validate divergence diffs.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";
import {
  parseDiff,
  readDivergence,
  renderComparison,
  totalDivergence,
} from "./divergence-report.ts";
import { ensureScratchDirectory } from "./queue.ts";

function withRepository(
  test: (git: (...args: string[]) => string, write: (path: string, text: string) => void) => void,
) {
  const root = NodePath.resolve(import.meta.dirname, "../..");
  const directory = NodeFS.mkdtempSync(
    NodePath.resolve(ensureScratchDirectory(root), "upstream-divergence-test-"),
  );
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync(
      "git",
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
  const write = (path: string, text: string) => {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(directory, path)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(directory, path), text);
  };
  try {
    git("init", "--initial-branch=main");
    test(git, write);
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
}

const lines = (count: number, prefix = "line") =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index}\n`).join("");

describe("upstream divergence", () => {
  it("parses renames and binary files from -z diff output", () => {
    assert.deepEqual(
      parseDiff(
        "M\0a.ts\0R087\0old name.ts\0new name.ts\0A\0image.png\0",
        ["2\t1\ta.ts", "3\t0\t", "old name.ts", "new name.ts", "-\t-\timage.png", ""].join("\0"),
      ),
      [
        { status: "M", path: "a.ts", from: null, insertions: 2, deletions: 1 },
        { status: "R", path: "new name.ts", from: "old name.ts", insertions: 3, deletions: 0 },
        { status: "A", path: "image.png", from: null, insertions: 0, deletions: 0 },
      ],
    );
  });

  it("separates changed, removed and fork-only files and ignores vendored references and the lockfile", () => {
    withRepository((git, write) => {
      write("apps/web/edited.ts", lines(10));
      write("apps/web/removed.ts", lines(4));
      write(".repos/effect/index.ts", lines(3));
      write("pnpm-lock.yaml", lines(3));
      git("add", ".");
      git("commit", "-m", "upstream");
      const upstream = git("rev-parse", "HEAD").trim();

      write("apps/web/edited.ts", lines(10).replace("line 3\n", "fork line 3\nfork line 4\n"));
      git("rm", "-q", "apps/web/removed.ts");
      write("apps/web/forkOnly.ts", lines(6, "fork only"));
      write(".repos/effect/index.ts", lines(9));
      write("pnpm-lock.yaml", lines(9));
      git("add", ".");
      git("commit", "-m", "fork");

      const run = (command: string, args: string[]) => git(...args);
      assert.deepEqual(totalDivergence(readDivergence(run, upstream, "HEAD").files), {
        changedFiles: 1,
        changedInsertions: 2,
        changedDeletions: 1,
        removedFiles: 1,
        removedLines: 4,
        forkOnlyFiles: 1,
        forkOnlyLines: 6,
      });
    });
  });

  it("reports files that start to differ, match upstream again, or survive an upstream deletion", () => {
    withRepository((git, write) => {
      write("starts.ts", lines(5));
      write("returns.ts", lines(5));
      write("kept.ts", lines(5));
      git("add", ".");
      git("commit", "-m", "upstream before");
      const upstreamBefore = git("rev-parse", "HEAD").trim();
      git("rm", "-q", "kept.ts");
      git("commit", "-m", "upstream after");
      const upstreamAfter = git("rev-parse", "HEAD").trim();

      git("checkout", "-q", "-b", "fork", upstreamBefore);
      write("returns.ts", lines(5, "fork"));
      git("commit", "-qam", "fork before");
      const forkBefore = git("rev-parse", "HEAD").trim();
      write("returns.ts", lines(5));
      write("starts.ts", lines(6));
      git("commit", "-qam", "fork after");

      const run = (command: string, args: string[]) => git(...args);
      const report = renderComparison(
        readDivergence(run, upstreamBefore, forkBefore),
        readDivergence(run, upstreamAfter, "HEAD"),
        { before: "Before", after: "After", heading: "Upstream divergence" },
        { upstream: (sha) => sha.slice(0, 7), fork: (path) => `\`${path}\`` },
        new Set(git("ls-tree", "-r", "-z", "--name-only", upstreamBefore).split("\0")),
      );
      const section = (heading: string) =>
        report.split("### ").find((part) => part.startsWith(heading)) ?? "";
      assert.include(section("Upstream files that start to differ (1)"), "`starts.ts`: +1 −0");
      assert.include(section("Upstream files that match upstream again (1)"), "`returns.ts`");
      assert.include(
        section("Upstream deleted these files and the fork keeps them (1)"),
        "`kept.ts`: 5 lines",
      );
      assert.include(report, "| Fork-only files | 0 | 1 | **+1** |");
    });
  });
});
