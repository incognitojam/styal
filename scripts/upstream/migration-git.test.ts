// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { makeUpstreamMigrationGit } from "./migration-git.ts";

it("checks unstaged, staged and untracked migration bytes and excludes deletions", () => {
  NodeFS.mkdirSync(NodePath.join(import.meta.dirname, "../../.scratch"), { recursive: true });
  const root = NodeFS.mkdtempSync(
    NodePath.join(import.meta.dirname, "../../.scratch/migration-git-"),
  );
  const git = (...args: Array<string>) =>
    NodeChildProcess.execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  try {
    git("init", "--quiet");
    NodeFS.writeFileSync(NodePath.join(root, "migration.ts"), "original\n");
    git("add", ".");
    const reader = makeUpstreamMigrationGit(root, true);
    const original = reader.blobs("WORKTREE", ["migration.ts"]).get("migration.ts");
    NodeFS.appendFileSync(NodePath.join(root, "migration.ts"), "// Comment edit.\n");
    expect(reader.show("WORKTREE", "migration.ts")).toContain("// Comment edit.");
    expect(reader.blobs("WORKTREE", ["migration.ts"]).get("migration.ts")).not.toBe(original);
    git("add", ".");
    expect(reader.blobs("WORKTREE", ["migration.ts"]).get("migration.ts")).toBe(
      git("hash-object", "migration.ts"),
    );
    NodeFS.writeFileSync(NodePath.join(root, "new.ts"), "new\n");
    expect(reader.blobs("WORKTREE", ["new.ts"]).get("new.ts")).toBe(git("hash-object", "new.ts"));
    NodeFS.unlinkSync(NodePath.join(root, "migration.ts"));
    expect(reader.blobs("WORKTREE", ["migration.ts"]).size).toBe(0);
    expect(reader.show("WORKTREE", "migration.ts")).toBeNull();
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
