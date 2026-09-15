// Runs inside a disposable Node container with only the archive and this script mounted.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

const archivesDirectory = process.argv[2];
NodeAssert.ok(archivesDirectory, "Pass a directory containing one CLI archive.");
const archives = NodeFS.readdirSync(archivesDirectory).filter((entry) => entry.endsWith(".tgz"));
NodeAssert.equal(archives.length, 1, "Expected exactly one CLI archive.");
const archive = NodePath.resolve(archivesDirectory, archives[0]);
const manifest = JSON.parse(
  NodeChildProcess.execFileSync("tar", ["-xOf", archive, "package/package.json"], {
    encoding: "utf8",
  }),
);
NodeAssert.equal(manifest.name, "@styal/cli");
NodeAssert.deepEqual(manifest.bin, { styal: "./dist/bin.mjs" });
NodeAssert.equal(manifest.repository.url, "https://github.com/incognitojam/styal");
NodeAssert.equal(manifest.license, "MIT");
NodeAssert.ok(!JSON.stringify(manifest).includes("catalog:"));
NodeAssert.ok(!JSON.stringify(manifest).includes("workspace:"));

const root = NodePath.resolve("/verification");
const install = NodePath.join(root, "install");
const state = NodePath.join(root, "state");
const project = NodePath.join(root, "project");
NodeFS.mkdirSync(project, { recursive: true });
NodeFS.writeFileSync(NodePath.join(project, "README.md"), "Synthetic CLI verification project.\n");
NodeChildProcess.execFileSync(
  "npm",
  [
    "install",
    "--prefix",
    install,
    "--no-audit",
    "--no-fund",
    "--allow-scripts=node-pty",
    "--allow-scripts=msgpackr-extract",
    archive,
  ],
  {
    stdio: "inherit",
  },
);
const cli = NodePath.join(install, "node_modules", ".bin", "styal");
const runCli = (...args) =>
  NodeChildProcess.execFileSync(cli, args, { cwd: project, encoding: "utf8", timeout: 60_000 });
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
NodeAssert.equal(preflight(2).status, "blocked");
NodeAssert.equal(preflight(3).status, "ready");
runCli("project", "add", project, "--title", "CLI verification", "--base-dir", state);

// Exercise the native dependency installed from npm, not a workspace copy.
const require = NodeModule.createRequire(
  NodePath.join(install, "node_modules/@styal/cli/package.json"),
);
const pty = require("node-pty");
await new Promise((resolve, reject) => {
  const terminal = pty.spawn("sh", ["-c", "printf styal-terminal-ok"], { cwd: project });
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

const origin = "http://127.0.0.1:3773";
async function exerciseServer(iteration) {
  const server = NodeChildProcess.spawn(
    cli,
    ["serve", "--host", "127.0.0.1", "--port", "3773", "--base-dir", state],
    { cwd: project, stdio: ["ignore", "pipe", "pipe"] },
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
    server.kill("SIGTERM");
    await exited;
    NodeFS.writeFileSync(NodePath.join(root, `server-${iteration}.log`), output);
  }
}
await exerciseServer(1);
await exerciseServer(2);
NodeAssert.ok(NodeFS.readFileSync(NodePath.join(state, "userdata/state.sqlite")).length > 0);
console.log(
  "CLI archive verified: install, executable, launcher compatibility, native terminal, pairing, and persistence across restart.",
);
