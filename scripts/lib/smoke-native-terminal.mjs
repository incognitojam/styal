// Run only as a child process with a parent-owned timeout. node-pty's Windows
// ConPTY output worker survives natural shell exit, so this probe explicitly
// exits after checking the terminal output and exit status.
import * as NodeAssert from "node:assert/strict";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

// oxlint-disable-next-line t3code/no-global-process-runtime -- This standalone probe runs outside the workspace Effect runtime.
const platform = process.platform;

const [install, project] = process.argv.slice(2);
NodeAssert.ok(install && project, "Pass the extracted install and project directories.");
const require = NodeModule.createRequire(NodePath.join(install, "smoke.cjs"));
const pty = require("node-pty");
await new Promise((resolve, reject) => {
  const terminal = pty.spawn(
    platform === "win32" ? NodePath.join(process.env.SystemRoot, "System32", "cmd.exe") : "/bin/sh",
    platform === "win32"
      ? ["/d", "/c", "echo styal-terminal-ok"]
      : ["-c", "printf styal-terminal-ok"],
    { cwd: project, env: process.env },
  );
  let output = "";
  terminal.onData((chunk) => {
    output += chunk;
  });
  terminal.onExit(({ exitCode }) => {
    try {
      NodeAssert.equal(exitCode, 0);
      NodeAssert.match(output, /styal-terminal-ok/);
      resolve();
    } catch (error) {
      reject(error);
    }
  });
});
process.exit(0);
