import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeTest from "node:test";
import { dependencyHash } from "./dependency-hash.mjs";

NodeTest.test("dependency generation follows indexed inputs across checkout differences", () => {
  NodeFS.mkdirSync(".scratch", { recursive: true });
  const cwd = NodeFS.mkdtempSync(".scratch/dependency-hash-test-");
  const git = (...args) => NodeChildProcess.execFileSync("git", args, { cwd });
  const write = (path, value) => NodeFS.writeFileSync(`${cwd}/${path}`, value);
  try {
    git("init", "-q");
    NodeAssert.throws(() => dependencyHash(cwd), /No dependency inputs/);
    NodeFS.mkdirSync(`${cwd}/apps/mobile/modules/example`, { recursive: true });
    NodeFS.mkdirSync(`${cwd}/patches`);
    write("package.json", "{}\n");
    write("apps/mobile/modules/example/Z.swift", "Z\n");
    write("apps/mobile/modules/example/a.swift", "a\n");
    write("patches/example.patch", "patch\n");
    git("add", ".");
    const initial = dependencyHash(cwd);
    // A checkout can change bytes and directory insertion order without changing
    // the indexed objects used by installs on the same commit.
    NodeFS.rmSync(`${cwd}/apps/mobile/modules/example/Z.swift`);
    write("apps/mobile/modules/example/a.swift", "a\r\n");
    write("apps/mobile/modules/example/Z.swift", "Z\r\n");
    NodeAssert.equal(dependencyHash(cwd), initial);
    write("unrelated.txt", "unrelated\n");
    git("add", "unrelated.txt");
    NodeAssert.equal(dependencyHash(cwd), initial);
    write("patches/example.patch", "changed patch\n");
    git("add", "patches/example.patch");
    NodeAssert.notEqual(dependencyHash(cwd), initial);
    const patched = dependencyHash(cwd);
    write("apps/mobile/modules/example/new.swift", "new module source\n");
    git("add", "apps/mobile/modules/example/new.swift");
    NodeAssert.notEqual(dependencyHash(cwd), patched);
  } finally {
    NodeFS.rmSync(cwd, { recursive: true, force: true });
  }
});
