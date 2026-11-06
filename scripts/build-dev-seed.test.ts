// @effect-diagnostics nodeBuiltinImport:off -- exercises the Python seed builder in a subprocess.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { it } from "@effect/vitest";

it("builds offline seeds without overwriting sources and terminates overdue snapshot children", () => {
  const root = NodePath.resolve(import.meta.dirname, "..");
  NodeFS.mkdirSync(NodePath.join(root, ".scratch"), { recursive: true });
  NodeChildProcess.execFileSync("python3", ["scripts/build-dev-seed.test.py"], {
    cwd: root,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    stdio: "pipe",
  });
});
