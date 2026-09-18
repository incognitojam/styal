// Verify a standalone archive using the same Node version used to build its native addons.
// All application state and logs stay in an isolated, synthetic scratch directory.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeNet from "node:net";

// oxlint-disable-next-line t3code/no-global-process-runtime -- This standalone artifact verifier runs outside the workspace Effect runtime.
const platform = process.platform;

const archive = NodePath.resolve(process.argv[2]);
const expectedVersion = process.argv[3];
NodeAssert.ok(expectedVersion, "Pass an archive path and expected version.");
const scratch = NodePath.resolve(".scratch");
NodeFS.mkdirSync(scratch, { recursive: true });
const root = NodeFS.mkdtempSync(NodePath.join(scratch, "cli-distribution-smoke-"));
const tar =
  platform === "win32"
    ? NodePath.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
    : "tar";
NodeChildProcess.execFileSync(tar, ["-xf", archive, "-C", root]);
const [entry, ...extra] = NodeFS.readdirSync(root);
NodeAssert.equal(extra.length, 0, "Expected one archive root.");
NodeAssert.ok(entry);
const install = NodePath.join(root, entry);
const state = NodePath.join(root, "state");
const project = NodePath.join(root, "project");
const home = NodePath.join(root, "home");
NodeFS.mkdirSync(project, { recursive: true });
NodeFS.mkdirSync(home, { recursive: true });
NodeFS.writeFileSync(NodePath.join(project, "README.md"), "Synthetic CLI verification project.\n");
const cli = NodePath.join(install, platform === "win32" ? "styal.exe" : "styal");
const manifest = { version: expectedVersion };
// No host credentials, provider configuration, or Node on PATH reaches the server.
const env = {
  PATH: "",
  HOME: home,
  USERPROFILE: home,
  TMPDIR: root,
  TEMP: root,
  STYAL_HOME: state,
  SHELL: "/bin/sh",
  ...(platform === "win32"
    ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec }
    : {}),
};
const runCli = (...args) =>
  NodeChildProcess.execFileSync(cli, args, {
    cwd: project,
    env,
    encoding: "utf8",
    timeout: 60_000,
  });
NodeAssert.match(
  runCli("--version"),
  new RegExp(`styal v${manifest.version.replaceAll(".", "\\.")}\\s*$`),
);
NodeAssert.match(runCli("--help"), /styal/);
const preflight = (protocol) =>
  JSON.parse(
    runCli(
      "__service-preflight",
      "--database-path",
      NodePath.join(state, "userdata/state.sqlite"),
      "--launcher-protocol",
      String(protocol),
    ),
  );
NodeAssert.equal(preflight(3).status, "blocked");
NodeAssert.equal(preflight(4).status, "ready");
runCli("project", "add", project, "--title", "CLI verification", "--base-dir", state);

// Exercise the native terminal from the extracted archive, not the workspace.
const require = NodeModule.createRequire(NodePath.join(install, "smoke.cjs"));
const pty = require("node-pty");
await new Promise((resolve, reject) => {
  const terminal = pty.spawn(
    platform === "win32" ? NodePath.join(env.SystemRoot, "System32", "cmd.exe") : "/bin/sh",
    platform === "win32"
      ? ["/d", "/c", "echo styal-terminal-ok"]
      : ["-c", "printf styal-terminal-ok"],
    { cwd: project, env },
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

const listener = NodeNet.createServer();
listener.listen(0, "127.0.0.1");
await NodeEvents.once(listener, "listening");
const port = listener.address().port;
await new Promise((resolve, reject) =>
  listener.close((error) => (error ? reject(error) : resolve())),
);
const origin = `http://127.0.0.1:${port}`;
async function exerciseServer(iteration, managed = false) {
  // Runtime state is persisted after HTTP activation. Observe its atomic rename
  // rather than racing the earlier pairing announcement or polling the disk.
  let resolveRuntimeState;
  let runtimeStateDeadline;
  const runtimeStateReady = new Promise((resolve, reject) => {
    resolveRuntimeState = resolve;
    runtimeStateDeadline = setTimeout(
      () => reject(new Error("Server did not persist its runtime state.")),
      60_000,
    );
  });
  const runtimeWatcher = NodeFS.watch(NodePath.join(state, "userdata"), (_event, filename) => {
    if (String(filename) !== "server-runtime.json") return;
    try {
      resolveRuntimeState(
        JSON.parse(
          NodeFS.readFileSync(NodePath.join(state, "userdata/server-runtime.json"), "utf8"),
        ),
      );
    } catch {
      /* Atomic replacement can emit a removal event before the rename. */
    }
  });
  const server = NodeChildProcess.spawn(
    cli,
    managed
      ? ["__service-launcher"]
      : [
          "serve",
          "--host",
          "127.0.0.1",
          "--port",
          String(port),
          "--no-browser",
          "--base-dir",
          state,
        ],
    {
      cwd: project,
      env: {
        ...env,
        T3CODE_PORT: String(port),
        T3CODE_HOST: "127.0.0.1",
        T3CODE_NO_BROWSER: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  const exited = NodeEvents.once(server, "exit");
  try {
    const pairingUrl = await new Promise((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Error("Server did not announce pairing readiness.")),
        60_000,
      );
      const inspect = (chunk) => {
        output += chunk;
        const match = /Pairing URL: (https?:\/\/\S+)/.exec(output);
        if (match) {
          clearTimeout(deadline);
          resolve(new URL(match[1]));
        }
      };
      server.stdout.on("data", inspect);
      server.stderr.on("data", inspect);
      server.once("error", (error) => {
        clearTimeout(deadline);
        reject(error);
      });
      server.once("exit", (code) => {
        clearTimeout(deadline);
        reject(new Error(`Server exited before readiness: ${code}`));
      });
    });
    // The remote bootstrap uses these helpers when no host Node is installed.
    const runtimeState = await runtimeStateReady;
    NodeAssert.equal(runtimeState.serviceManaged, managed);
    NodeAssert.equal(
      runCli("__ssh-helper", "runtime-port", NodePath.join(state, "userdata/server-runtime.json")),
      `${runtimeState.pid} ${port}`,
    );
    const portFile = NodePath.join(root, "ssh-port");
    NodeFS.writeFileSync(portFile, String(port));
    const availablePort = Number(runCli("__ssh-helper", "pick-port", portFile, String(port), "20"));
    NodeAssert.ok(availablePort > port && availablePort < port + 20);
    runCli("__ssh-helper", "wait-ready", String(port), "2000", "1000");
    const index = await fetch(origin);
    NodeAssert.equal(index.status, 200);
    NodeAssert.match(await index.text(), /<html/i);
    const descriptor = await fetch(`${origin}/.well-known/t3/environment`).then((response) =>
      response.json(),
    );
    NodeAssert.equal(descriptor.serverVersion, manifest.version);
    NodeAssert.equal(descriptor.serverPackageName, "@styal/cli");
    const token = new URLSearchParams(pairingUrl.hash.slice(1)).get("token");
    NodeAssert.ok(token);
    const session = await fetch(`${origin}/api/auth/browser-session`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ credential: token }),
    });
    NodeAssert.equal(session.status, 200);
    NodeAssert.equal((await session.json()).authenticated, true);
    const cookie = session.headers
      .getSetCookie()
      .map((entry) => entry.split(";")[0])
      .join("; ");
    NodeAssert.ok(cookie);
    const snapshot = await fetch(`${origin}/api/orchestration/snapshot`, { headers: { cookie } });
    NodeAssert.equal(snapshot.status, 200);
    const data = await snapshot.json();
    NodeAssert.ok(data.projects.some((entry) => entry.title === "CLI verification"));
    console.log(
      `Pass ${iteration}: bundled web, matching version, pairing, authenticated project snapshot.`,
    );
  } finally {
    clearTimeout(runtimeStateDeadline);
    runtimeWatcher.close();
    server.kill("SIGTERM");
    const deadline = setTimeout(() => server.kill("SIGKILL"), 10_000);
    try {
      await exited;
    } finally {
      clearTimeout(deadline);
    }
    NodeFS.writeFileSync(NodePath.join(root, `server-${iteration}.log`), output);
  }
}
await exerciseServer(1);
await exerciseServer(2);
if (platform !== "win32") {
  const versionDir = NodePath.join(state, "runtime/styal-executable/versions", expectedVersion);
  NodeFS.cpSync(install, versionDir, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(versionDir, ".install-complete"), `${expectedVersion}\n`);
  NodeFS.writeFileSync(
    NodePath.join(state, "runtime/service-state.json"),
    JSON.stringify({ protocol: 4, activeVersion: expectedVersion }),
  );
  await exerciseServer(3, true);
}
NodeAssert.ok(NodeFS.readFileSync(NodePath.join(state, "userdata/state.sqlite")).length > 0);
console.log(
  "CLI archive verified: install, executable, launcher compatibility, native terminal, pairing, and persistence across restart.",
);

console.log(`Verification evidence: ${root}`);
