// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as Effect from "effect/Effect";
import { assert, it } from "@effect/vitest";
import { checkEarlyTree, failureSignatures } from "./early-check.ts";

it("keeps a new failure when the same test step already fails on the base", () => {
  const base = failureSignatures([
    {
      name: "tests apps/server (79 related files)",
      ok: false,
      output: " FAIL src/usage/UsageService.test.ts > date window",
    },
  ]);
  const candidate = failureSignatures([
    {
      name: "tests apps/server (79 related files)",
      ok: false,
      output:
        " FAIL src/usage/UsageService.test.ts > date window\n FAIL src/telemetry/SettingsSnapshot.test.ts > settings",
    },
  ]);
  assert.deepEqual(
    candidate.filter((failure) => !base.includes(failure)),
    ["tests apps/server: src/telemetry/SettingsSnapshot.test.ts"],
  );
  assert.deepEqual(
    failureSignatures([{ name: "typecheck apps/server", ok: false, output: "error TS2345" }]),
    ["typecheck apps/server"],
  );
  assert.deepEqual(failureSignatures([{ name: "tests apps/server", ok: true, output: "" }]), []);
});

it.live(
  "verifies the merged checkout and reruns its failure on the base without changing source HEAD",
  () =>
    Effect.promise(async () => {
      const root = NodeFS.mkdtempSync(
        NodeURL.fileURLToPath(new URL("../../../.scratch/early-check-test-", import.meta.url)),
      );
      const git = (...args: string[]) =>
        NodeChildProcess.execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
      try {
        git("init", "-q");
        git("config", "user.name", "Fixture");
        git("config", "user.email", "fixture@example.invalid");
        NodeFS.writeFileSync(NodePath.join(root, "fixture.txt"), "base");
        git("add", ".");
        git("commit", "-qm", "base");
        const base = git("rev-parse", "HEAD");
        NodeFS.writeFileSync(NodePath.join(root, "fixture.txt"), "broken");
        git("commit", "-qam", "candidate");
        const head = git("rev-parse", "HEAD");
        const bin = NodePath.join(root, "bin");
        NodeFS.mkdirSync(bin);
        NodeFS.writeFileSync(
          NodePath.join(bin, "vp"),
          '#!/bin/sh\nif [ -n "$TMPDIR" ]; then echo "error: inherited TMPDIR"; exit 1; fi\nif [ "$1" = "fmt" ] && [ "$(cat fixture.txt)" = "broken" ]; then echo "error: candidate regression"; exit 1; fi\n',
          { mode: 0o755 },
        );
        const result = await checkEarlyTree({
          root,
          scratch: root,
          objectDirectory: NodePath.join(root, ".git/objects"),
          head,
          base,
          env: { ...process.env, PATH: bin + NodePath.delimiter + process.env.PATH, TMPDIR: root },
        });
        assert.equal(result.status, "failed");
        assert.deepEqual(result.failures, ["formatting"]);
        assert.deepEqual(result.baselineFailures, []);
        const shared = {
          root,
          scratch: root,
          objectDirectory: NodePath.join(root, ".git/objects"),
          env: { ...process.env, PATH: bin + NodePath.delimiter + process.env.PATH },
        };
        const preexisting = await checkEarlyTree({ ...shared, head, base: head });
        assert.equal(preexisting.status, "baseline-failed");
        assert.deepEqual(preexisting.baselineFailures, ["formatting"]);
        const clean = await checkEarlyTree({ ...shared, head: base, base });
        assert.equal(clean.status, "passed");
        assert.equal(git("rev-parse", "HEAD"), head);
        assert.equal(NodeFS.readFileSync(NodePath.join(root, "fixture.txt"), "utf8"), "broken");
        assert.isFalse(NodeFS.readdirSync(root).some((name) => name.startsWith("early-check-")));
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    }),
);
