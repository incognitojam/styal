// @effect-diagnostics nodeBuiltinImport:off
import { assert, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import * as NodePath from "node:path";

it("loads an optional shared env file while preserving existing values", () => {
  const scratch = NodeURL.fileURLToPath(new URL("../../.scratch/", import.meta.url));
  NodeFS.mkdirSync(scratch, { recursive: true });
  const home = NodeFS.mkdtempSync(NodePath.join(scratch, "intake-eval-home-"));
  try {
    const run = (existing?: string, expected = existing ?? "synthetic") => {
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
      delete env.INTAKE_EVAL_TEST_VALUE;
      if (existing) env.INTAKE_EVAL_TEST_VALUE = existing;
      return NodeChildProcess.spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          "await import(process.argv[2]); process.exit(String(process.env.INTAKE_EVAL_TEST_VALUE) === process.argv[1] ? 0 : 1)",
          expected,
          new URL("./load-env.ts", import.meta.url).href,
        ],
        { env, encoding: "utf8" },
      );
    };
    assert.equal(run(undefined, "undefined").status, 0);
    NodeFS.mkdirSync(NodePath.resolve(home, ".config/styal"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.resolve(home, ".config/styal/evals.env"),
      "INTAKE_EVAL_TEST_VALUE=synthetic\n",
    );
    assert.equal(run().status, 0);
    assert.equal(run("existing").status, 0);
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
});
