// @effect-diagnostics nodeBuiltinImport:off -- These tests assert real POSIX modes on a temporary directory.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";

import { removeClerkTokenStorage } from "./RetiredSignInData.ts";

async function withStateDir(run: (stateDir: string) => Promise<void> | void): Promise<void> {
  const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-clerk-tokens-"));
  try {
    await run(stateDir);
  } finally {
    NodeFS.rmSync(stateDir, { recursive: true, force: true });
  }
}

describe("RetiredSignInData", () => {
  it("removes only retired token files and is safe to repeat", async () => {
    await withStateDir((stateDir) => {
      const directory = NodePath.join(stateDir, "clerk");
      NodeFS.mkdirSync(directory);
      const token = NodePath.join(directory, "clerk-tokens.json");
      const legacy = NodePath.join(stateDir, "clerk-tokens.json");
      const current = NodePath.join(stateDir, "relay-session.json");
      NodeFS.writeFileSync(token, "synthetic legacy credential");
      NodeFS.writeFileSync(legacy, "synthetic older credential");
      NodeFS.writeFileSync(current, "synthetic current session");
      removeClerkTokenStorage(stateDir, stateDir);
      removeClerkTokenStorage(stateDir, stateDir);
      assert.isFalse(NodeFS.existsSync(token));
      assert.isFalse(NodeFS.existsSync(legacy));
      assert.equal(NodeFS.readFileSync(current, "utf8"), "synthetic current session");
    });
  });

  it("does not traverse a symlinked retired directory", async () => {
    await withStateDir((stateDir) => {
      const target = NodePath.join(stateDir, "unrelated");
      NodeFS.mkdirSync(target);
      const token = NodePath.join(target, "clerk-tokens.json");
      NodeFS.writeFileSync(token, "synthetic unrelated credential");
      NodeFS.symlinkSync(target, NodePath.join(stateDir, "clerk"), "junction");
      assert.throws(() => removeClerkTokenStorage(stateDir, stateDir));
      assert.equal(NodeFS.readFileSync(token, "utf8"), "synthetic unrelated credential");
    });
  });

});
