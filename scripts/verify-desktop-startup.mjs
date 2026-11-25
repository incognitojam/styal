/* oxlint-disable t3code/no-global-process-runtime -- Standalone packaging check runs outside Effect. */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export function verifyDesktopStartup(executable, version) {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "styal-startup-check-"));
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(NODE_|ELECTRON_|T3CODE_|STYAL_)/.test(name)) delete env[name];
  }
  Object.assign(env, {
    STYAL_HOME: home,
    XDG_CONFIG_HOME: home,
    XDG_DATA_HOME: home,
    XDG_CACHE_HOME: home,
    APPDATA: home,
    LOCALAPPDATA: home,
    TMPDIR: home,
    TMP: home,
    TEMP: home,
    T3CODE_DISABLE_AUTO_UPDATE: "true",
  });
  const needsDisplay = process.platform === "linux" && !env.DISPLAY;
  try {
    // --version exits after main.cjs imports load, before acquiring the app runtime.
    const result = NodeChildProcess.spawnSync(
      needsDisplay ? "xvfb-run" : executable,
      [...(needsDisplay ? ["-a", executable] : []), "--no-sandbox", "--version"],
      { cwd: home, env, encoding: "utf8", timeout: 30_000 },
    );
    if (
      result.error ||
      result.status !== 0 ||
      result.stdout.trim().split(/\r?\n/).at(-1) !== version
    ) {
      throw new Error(
        `Packaged desktop startup failed (${result.status ?? result.signal}): ${result.error ?? ""}\n${result.stdout}\n${result.stderr}`,
      );
    }
    console.log(`Packaged desktop startup passed: ${version}`);
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  const [, , executable, version] = process.argv;
  if (!executable || !version)
    throw new Error("Usage: verify-desktop-startup.mjs <executable> <expected-version>");
  verifyDesktopStartup(NodePath.resolve(executable), version);
}
