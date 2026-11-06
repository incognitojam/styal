// @effect-diagnostics nodeBuiltinImport:off -- exercises the Python seed builder in a subprocess.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import { it } from "@effect/vitest";

it("builds offline seeds without overwriting sources and terminates overdue snapshot children", () => {
  NodeFS.mkdirSync(".scratch", { recursive: true });
  NodeChildProcess.execFileSync("python3", ["scripts/build-dev-seed.test.py"], {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    stdio: "pipe",
  });
});
