// @effect-diagnostics nodeBuiltinImport:off - Real disposable git histories validate divergence diffs.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { parse } from "yaml";
import {
  parseDiff,
  readDivergence,
  renderComparison,
  totalDivergence,
} from "./divergence-report.ts";

function withRepository(
  test: (
    git: (...args: string[]) => string,
    write: (path: string, text: string) => void,
    directory: string,
  ) => void,
) {
  const root = NodePath.resolve(import.meta.dirname, "../..");
  NodeChildProcess.execFileSync("git", ["check-ignore", "-q", ".scratch/"], { cwd: root });
  NodeFS.mkdirSync(NodePath.join(root, ".scratch"), { recursive: true });
  const directory = NodeFS.mkdtempSync(NodePath.join(root, ".scratch/upstream-divergence-test-"));
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
    test(git, write, directory);
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
}

const lines = (count: number, prefix = "line") =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index}\n`).join("");

describe("upstream divergence", () => {
  it("reports a pull request from a checkout without installed dependencies", () => {
    withRepository((git, write, directory) => {
      write("shared.ts", "upstream\n");
      git("add", ".");
      git("commit", "-m", "upstream");
      const upstream = git("rev-parse", "HEAD").trim();
      git("update-ref", "refs/remotes/upstream/main", upstream);
      write(
        ".github/upstream-intake.json",
        JSON.stringify({
          upstreamRepository: "example/upstream",
          baseline: upstream,
          target: upstream,
          exceptions: {},
        }),
      );
      git("add", ".");
      git("commit", "-m", "fork base");
      const base = git("rev-parse", "HEAD").trim();
      write("shared.ts", "fork\n");
      git("commit", "-am", "pull request");

      NodeFS.cpSync(import.meta.dirname, NodePath.join(directory, "scripts/upstream"), {
        recursive: true,
        filter: (path) => !path.endsWith(".test.ts"),
      });
      write("package.json", JSON.stringify({ type: "module" }));
      // Reject ancestor workspace packages too, so local installs cannot hide CI regressions.
      write(
        "no-packages.mjs",
        `import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith("node:") && !specifier.startsWith(".") && !specifier.startsWith("file:"))
    throw new Error("Unexpected package import: " + specifier);
  return nextResolve(specifier, context);
} });`,
      );
      const report = NodeChildProcess.execFileSync(
        process.execPath,
        [
          "--import",
          "./no-packages.mjs",
          "scripts/upstream/divergence-report.ts",
          "--base",
          base,
          "--head",
          "HEAD",
          "--pr-comment",
        ],
        { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      assert.include(report, "<!-- upstream-divergence -->");
      assert.include(report, "<!-- styal-report:attention -->");
      assert.include(report, "`shared.ts`: +1 −1 from upstream");
    });
  });

  it("runs trusted current publisher code while comparing the pull request base", () => {
    const workflow = parse(
      NodeFS.readFileSync(
        new URL("../../.github/workflows/upstream-divergence-comment.yml", import.meta.url),
        "utf8",
      ),
    );
    const steps = workflow.jobs.comment.steps;
    const checkout = steps.find((step: { uses?: string }) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    const report = steps.find((step: { name?: string }) => step.name === "Write report");
    assert.equal(checkout.with.ref, "${{ github.event.repository.default_branch }}");
    assert.equal(report.env.BASE_SHA, "${{ github.event.pull_request.base.sha }}");
    assert.include(report.run, '--base "$BASE_SHA"');
    withRepository((git, write, directory) => {
      const path = ".github/workflows/synthetic.yml";
      write(path, "main\n");
      git("add", ".");
      git("commit", "-m", "main");
      git("switch", "-c", "stack-base");
      write(path, "stack base\n");
      git("commit", "-am", "stack base");
      const base = git("rev-parse", "HEAD").trim();
      git("switch", "-c", "stack-head");
      write(path, "stack head\n");
      git("commit", "-am", "stack head");
      const head = git("rev-parse", "HEAD").trim();
      git("update-ref", "refs/pull/123/head", head);
      git("switch", "main");
      git("config", "uploadpack.allowFilter", "true");
      git("config", "uploadpack.allowAnySHA1InWant", "true");
      const checkout = NodePath.join(directory, "publisher");
      git(
        "clone",
        "--filter=blob:none",
        "--no-checkout",
        "--branch=main",
        `file://${directory}`,
        checkout,
      );
      const publisher = (...args: string[]) => git("-C", checkout, ...args);
      publisher("sparse-checkout", "set", "--no-cone", "/scripts/", "/.github/");
      publisher("checkout", "main");
      publisher("config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main");
      git("switch", "stack-head");
      write(path, "moved after the event\n");
      git("commit", "-am", "move PR head");
      git("update-ref", "refs/pull/123/head", "HEAD");
      git("switch", "main");
      const fetch = steps.find(
        (step: { name?: string }) => step.name === "Fetch full file contents",
      );
      NodeChildProcess.execFileSync("bash", ["-c", fetch.run], {
        cwd: checkout,
        env: { ...process.env, BASE_SHA: base, HEAD_SHA: head, PR_NUMBER: "123" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      assert.equal(publisher("rev-parse", "refs/remotes/pr/head").trim(), head);
      assert.equal(publisher("cat-file", "-t", base).trim(), "commit");
      assert.equal(publisher("show", `${base}:${path}`), "stack base\n");
      assert.equal(publisher("show", `refs/remotes/pr/head:${path}`), "stack head\n");
      assert.include(publisher("diff", "-M", "--name-status", base, "refs/remotes/pr/head"), path);
    });
  });

  it("marks flat divergence quiet and any increasing measure loud", () => {
    const base = { fork: "fork", upstream: "upstream", files: [] };
    const labels = {
      before: "before",
      after: "after",
      heading: "report",
      marker: "<!-- upstream-divergence -->",
    };
    const links = { upstream: (sha: string) => sha, fork: (path: string) => path };
    assert.include(
      renderComparison(base, base, labels, links, new Set()),
      "<!-- styal-report:ok -->",
    );
    const grown = {
      ...base,
      files: [{ status: "A" as const, path: "new.ts", from: null, insertions: 1, deletions: 0 }],
    };
    assert.include(
      renderComparison(base, grown, labels, links, new Set()),
      "<!-- styal-report:attention -->",
    );
    assert.include(
      renderComparison(grown, base, labels, links, new Set()),
      "<!-- styal-report:ok -->",
    );
  });

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
        {
          before: "Before",
          after: "After",
          heading: "Upstream divergence",
          marker: "<!-- upstream-divergence -->",
        },
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
      assert.include(report, "<!-- styal-report:attention -->");
      assert.include(report, "| Fork-only files | 0 | 1 | **+1** |");
    });
  });
});
