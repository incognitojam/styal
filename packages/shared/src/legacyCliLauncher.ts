/**
 * Keep the old @styal/cli dist/bin.mjs entry so protocol 3 services can run
 * preflight and report the required local migration. Forward IPC and signals
 * as well as arguments for callers that still use the Node entry point.
 */
export function legacyCliLauncherScript(): string {
  return `import { spawn } from "node:child_process";
import { constants } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const executableName = process.platform === "win32" ? "styal.exe" : "styal";
const executable = join(dirname(require.resolve("@styal/cli-" + process.platform + "-" + process.arch + "/package.json")), executableName);
const ipc = process.send !== undefined;
const child = spawn(executable, process.argv.slice(2), {
  stdio: ipc ? ["inherit", "inherit", "inherit", "ipc"] : "inherit",
});
const fail = (error) => {
  if (!error) return;
  process.stderr.write("styal: " + error.message + "\\n");
  child.kill("SIGTERM");
  process.exitCode = 1;
};
if (ipc) {
  process.on("message", (message) => { if (child.connected) child.send(message, fail); });
  child.on("message", (message) => { if (process.connected) process.send(message, fail); });
  process.on("disconnect", () => { if (child.connected) child.disconnect(); });
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("error", (error) => { fail(error); process.exit(1); });
child.on("exit", (code, signal) => process.exit(code ?? 128 + (constants.signals[signal] || 1)));
`;
}
