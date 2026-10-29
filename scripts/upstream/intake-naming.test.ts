// @effect-diagnostics nodeBuiltinImport:off - A disposable git history exercises a real cherry-pick.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";

import { pickUpstreamCommit } from "./intake-run.ts";
import { ensureScratchDirectory } from "./queue.ts";

function fixtureRepository() {
  const root = NodePath.resolve(import.meta.dirname, "../..");
  const directory = NodeFS.mkdtempSync(
    NodePath.resolve(ensureScratchDirectory(root), "intake-naming-test-"),
  );
  // A GIT_DIR inherited from a hook or bisect would point these commands at the real repository.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
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
      { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env },
    ).trim();
  const write = (path: string, text: string) => {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(directory, path)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(directory, path), text);
  };
  const read = (path: string) => NodeFS.readFileSync(NodePath.join(directory, path), "utf8");
  /** Commits `files` on a side branch and returns its sha, back on main. */
  const upstreamCommit = (files: Readonly<Record<string, string>>) => {
    git("switch", "-q", "-c", "upstream");
    for (const [path, text] of Object.entries(files)) write(path, text);
    git("add", "-A");
    git("commit", "-q", "-m", "upstream change");
    const sha = git("rev-parse", "HEAD");
    git("switch", "-q", "main");
    return sha;
  };
  const base = (files: Readonly<Record<string, string>>) => {
    git("init", "-q", "--initial-branch=main");
    for (const [path, text] of Object.entries(files)) write(path, text);
    git("add", "-A");
    git("commit", "-q", "-m", "base");
  };
  const remove = () => NodeFS.rmSync(directory, { recursive: true, force: true });
  return { directory, git, read, base, upstreamCommit, remove };
}

describe("pickUpstreamCommit naming", () => {
  it("renames upstream names in the pick's strings and the assertions that quote them", () => {
    const { directory, git, read, base, upstreamCommit, remove } = fixtureRepository();
    try {
      // A name already on the base belongs to whichever pick added it, not this one.
      base({
        "apps/web/src/link.ts":
          'export const ready = true;\nexport const earlier = "T3 Tools Inc. and T3 Code";\n',
      });
      const upstream = upstreamCommit({
        "apps/web/src/link.ts": [
          "export const ready = true;",
          'export const earlier = "T3 Tools Inc. and T3 Code";',
          "// Shown until T3 Connect links this environment.",
          'export const message = "Link this environment to T3 Connect first.";',
          'export const privacy = "https://t3.codes/privacy-policy";',
          "",
        ].join("\n"),
        "apps/web/src/link.test.ts": [
          'it("asks to link T3 Connect", () => {',
          '  expect(message).toBe("Link this environment to T3 Connect first.");',
          '  const project = { title: "T3 Code" };',
          "});",
          "",
        ].join("\n"),
      });

      const outcome = pickUpstreamCommit(directory, upstream, {
        rerere: false,
        skipLockfile: true,
      });

      assert.strictEqual(outcome.status, "clean");
      assert.deepStrictEqual(
        outcome.adaptations.filter((adaptation) => adaptation.kind === "naming"),
        [
          {
            kind: "naming",
            path: "apps/web/src/link.ts",
            detail: "T3 Connect -> styal Link",
          },
          {
            kind: "naming",
            path: "apps/web/src/link.test.ts",
            detail: "T3 Connect -> styal Link",
          },
        ],
      );
      assert.include(
        read("apps/web/src/link.ts"),
        'export const message = "Link this environment to styal Link first.";',
      );
      assert.include(read("apps/web/src/link.ts"), "// Shown until T3 Connect links");
      assert.include(read("apps/web/src/link.ts"), '"T3 Tools Inc. and T3 Code"');
      assert.strictEqual(
        read("apps/web/src/link.test.ts"),
        [
          'it("asks to link T3 Connect", () => {',
          '  expect(message).toBe("Link this environment to styal Link first.");',
          '  const project = { title: "T3 Code" };',
          "});",
          "",
        ].join("\n"),
      );
      assert.strictEqual(git("diff", "--name-only"), "");
      assert.deepStrictEqual(outcome.identityReview, [
        "apps/web/src/link.ts: https://t3.codes/privacy-policy",
      ]);
    } finally {
      remove();
    }
  });

  it("renames test assertions that quote text the fork renames at delivery", () => {
    const { directory, read, base, upstreamCommit, remove } = fixtureRepository();
    try {
      base({
        "packages/provider-core/src/server/orchestrationInstructions.ts":
          "export const MODE = `## T3 Code interaction mode: Default\n\nAssume.`;\n",
      });
      const upstream = upstreamCommit({
        "apps/server/src/orchestration-v2/Adapters/AcpAdapterV2.test.ts":
          'assert.include(text, "T3 Code interaction mode: Default");\n',
      });

      pickUpstreamCommit(directory, upstream, { rerere: false, skipLockfile: true });

      assert.strictEqual(
        read("apps/server/src/orchestration-v2/Adapters/AcpAdapterV2.test.ts"),
        'assert.include(text, "styal interaction mode: Default");\n',
      );
    } finally {
      remove();
    }
  });
});
