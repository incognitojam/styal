import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { dependencyHash } from "./dependency-hash.mjs";

test("dependency generation follows indexed inputs across checkout differences", () => {
  mkdirSync(".scratch", { recursive: true });
  const cwd = mkdtempSync(".scratch/dependency-hash-test-");
  const git = (...args) => execFileSync("git", args, { cwd });
  const write = (path, value) => writeFileSync(`${cwd}/${path}`, value);
  try {
    git("init", "-q");
    assert.throws(() => dependencyHash(cwd), /No dependency inputs/);
    mkdirSync(`${cwd}/apps/mobile/modules/example`, { recursive: true });
    mkdirSync(`${cwd}/patches`);
    write("package.json", "{}\n");
    write("apps/mobile/modules/example/Z.swift", "Z\n");
    write("apps/mobile/modules/example/a.swift", "a\n");
    write("patches/example.patch", "patch\n");
    git("add", ".");
    const initial = dependencyHash(cwd);
    // A checkout can change bytes and directory insertion order without changing
    // the indexed objects used by installs on the same commit.
    rmSync(`${cwd}/apps/mobile/modules/example/Z.swift`);
    write("apps/mobile/modules/example/a.swift", "a\r\n");
    write("apps/mobile/modules/example/Z.swift", "Z\r\n");
    assert.equal(dependencyHash(cwd), initial);
    write("unrelated.txt", "unrelated\n");
    git("add", "unrelated.txt");
    assert.equal(dependencyHash(cwd), initial);
    write("patches/example.patch", "changed patch\n");
    git("add", "patches/example.patch");
    assert.notEqual(dependencyHash(cwd), initial);
    const patched = dependencyHash(cwd);
    write("apps/mobile/modules/example/new.swift", "new module source\n");
    git("add", "apps/mobile/modules/example/new.swift");
    assert.notEqual(dependencyHash(cwd), patched);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
