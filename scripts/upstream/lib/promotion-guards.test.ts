// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import { parse } from "yaml";

it("blocks moved base and candidate refs before pushing, and promotes an unchanged pair", () => {
  const root = NodePath.resolve(import.meta.dirname, "../../..");
  NodeChildProcess.execFileSync("git", ["check-ignore", "-q", ".scratch/"], { cwd: root });
  const directory = NodeFS.mkdtempSync(NodePath.join(root, ".scratch/intake-followup-guards-"));
  const cwd = NodePath.join(directory, "checkout");
  const remote = NodePath.join(directory, "remote.git");
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  try {
    NodeFS.mkdirSync(cwd);
    git("init", "--bare", remote);
    git("init", "-b", "main");
    git("config", "user.name", "Synthetic");
    git("config", "user.email", "synthetic@example.invalid");
    git("remote", "add", "origin", remote);
    const commit = (text: string) => {
      NodeFS.writeFileSync(NodePath.join(cwd, "fixture"), text);
      git("add", "fixture");
      git("commit", "-qm", "fixture");
      return git("rev-parse", "HEAD");
    };
    const base = commit("base");
    git("push", "origin", "HEAD:main");
    const head = commit("candidate");
    git("push", "origin", "HEAD:refs/heads/intake/fixture");
    const moved = commit("moved");
    const workflow = parse(
      NodeFS.readFileSync(
        NodePath.join(root, ".github/workflows/promote-upstream-intake.yml"),
        "utf8",
      ),
    );
    const script = workflow.jobs.promote.steps
      .find((step: { name?: string }) => step.name === "Fast-forward main to the candidate")
      .run.replace(/\$\{\{.*?\}\}/gu, "synthetic");
    const run = () =>
      NodeChildProcess.spawnSync("bash", ["-c", script], {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          EXPECTED_BASE_SHA: base,
          CANDIDATE_SHA: head,
          CANDIDATE_BRANCH: "intake/fixture",
          CI_RUN_URL: "https://example.invalid/run",
          SOURCE_PRS: "",
          SOURCE_COMMITS: "",
          GITHUB_STEP_SUMMARY: NodePath.join(directory, "summary"),
        },
      });
    const main = () => git("ls-remote", "origin", "refs/heads/main").split(/\s/u)[0];
    git("push", "origin", `${moved}:refs/heads/main`);
    const baseMoved = run();
    assert.equal(baseMoved.status, 1);
    assert.include(baseMoved.stdout, "main moved after validation");
    assert.equal(main(), moved);
    git("push", "--force", "origin", `${base}:refs/heads/main`);
    git("push", "origin", `${moved}:refs/heads/intake/fixture`);
    const candidateMoved = run();
    assert.equal(candidateMoved.status, 1);
    assert.include(candidateMoved.stdout, "intake branch moved after validation");
    assert.equal(main(), base);
    git("push", "--force", "origin", `${head}:refs/heads/intake/fixture`);
    const unchanged = run();
    assert.equal(unchanged.status, 0, unchanged.stderr);
    assert.equal(main(), head);
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});
