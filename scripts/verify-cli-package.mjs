// Runs inside a disposable Node container with only the npm launcher tarball,
// the release's CLI archives, and this script mounted. The archives directory
// stands in for the GitHub Release: it is served over local HTTP and the
// launcher is pointed at it with STYAL_RELEASE_BASE_URL.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

const packageDirectory = process.argv[2];
const releaseDirectory = process.argv[3];
NodeAssert.ok(packageDirectory, "Pass a directory containing the cli.tgz launcher tarball.");
NodeAssert.ok(releaseDirectory, "Pass a directory containing the CLI archives and SHA256SUMS.");
const archive = NodePath.resolve(packageDirectory, "cli.tgz");
const manifest = JSON.parse(
  NodeChildProcess.execFileSync("tar", ["-xOf", archive, "package/package.json"], {
    encoding: "utf8",
  }),
);
NodeAssert.equal(manifest.name, "@styal/cli");
NodeAssert.deepEqual(manifest.bin, { styal: "./bin/styal.mjs" });
NodeAssert.equal(manifest.dependencies, undefined);
NodeAssert.equal(manifest.optionalDependencies, undefined);
NodeAssert.equal(manifest.repository.url, "https://github.com/incognitojam/styal");
NodeAssert.equal(manifest.license, "MIT");
NodeAssert.ok(!JSON.stringify(manifest).includes("catalog:"));
NodeAssert.ok(!JSON.stringify(manifest).includes("workspace:"));

// Serves `releases/download/v<version>/<asset>` from the archives directory.
// It runs in its own process because the checks below block on execFileSync.
const RELEASE_SERVER = `
const NodeFS = require("node:fs");
const NodePath = require("node:path");
const [directory, version] = process.argv.slice(1);
const server = require("node:http").createServer((request, response) => {
  const prefix = "/v" + version + "/";
  const name = request.url.startsWith(prefix) ? request.url.slice(prefix.length) : "";
  const file = NodePath.join(directory, name);
  if (name === "" || name.includes("/") || !NodeFS.existsSync(file)) return response.writeHead(404).end();
  response.writeHead(200, { "content-length": NodeFS.statSync(file).size });
  NodeFS.createReadStream(file).pipe(response);
});
server.listen(0, "127.0.0.1", () => process.stdout.write("port " + server.address().port + "\\n"));
`;
const release = NodeChildProcess.spawn(
  process.execPath,
  ["-e", RELEASE_SERVER, releaseDirectory, manifest.version],
  { stdio: ["ignore", "pipe", "inherit"] },
);
const releaseBaseUrl = await new Promise((resolve, reject) => {
  let buffered = "";
  release.stdout.setEncoding("utf8");
  release.stdout.on("data", (chunk) => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    const port = lines.find((line) => line.startsWith("port "));
    if (port) resolve(`http://127.0.0.1:${port.slice(5)}`);
  });
  release.once("exit", (code) => reject(new Error(`Release server exited: ${code}`)));
});

const root = NodePath.resolve(process.argv[4] ?? ".scratch/cli-distribution-npm-smoke");
const install = NodePath.join(root, "install");
const state = NodePath.join(root, "state");
const project = NodePath.join(root, "project");
NodeFS.mkdirSync(project, { recursive: true });
NodeFS.writeFileSync(NodePath.join(project, "README.md"), "Synthetic CLI verification project.\n");
NodeFS.mkdirSync(install, { recursive: true });
NodeFS.writeFileSync(
  NodePath.join(install, "package.json"),
  JSON.stringify({
    private: true,
    allowScripts: { "node-pty": true, "msgpackr-extract": true },
  }),
);
NodeChildProcess.execFileSync(
  "npm",
  ["install", "--prefix", install, "--no-audit", "--no-fund", "--ignore-scripts", archive],
  {
    stdio: "inherit",
  },
);
const cli = NodePath.join(install, "node_modules", ".bin", "styal");
const env = {
  PATH: process.env.PATH,
  HOME: NodePath.join(root, "home"),
  STYAL_HOME: state,
  STYAL_RELEASE_BASE_URL: releaseBaseUrl,
  NO_COLOR: "1",
};
const runtimeDir = NodePath.join(state, "runtime/styal-executable/versions", manifest.version);
NodeFS.mkdirSync(env.HOME, { recursive: true });
const runCli = (...args) =>
  NodeChildProcess.execFileSync(cli, args, {
    cwd: project,
    env,
    encoding: "utf8",
    timeout: 60_000,
  });
// The first run downloads and verifies this platform's archive.
NodeAssert.match(
  runCli("--version"),
  new RegExp(`styal v${manifest.version.replaceAll(".", "\\.")}\\s*$`),
);
NodeAssert.equal(
  NodeFS.readFileSync(NodePath.join(runtimeDir, ".install-complete"), "utf8").trim(),
  manifest.version,
);
// Every later run must reuse that download, so the release goes away now.
const releaseExited = NodeEvents.once(release, "exit");
release.kill();
await releaseExited;
NodeAssert.match(runCli("--help"), /styal/);
const preflight = (protocol) =>
  JSON.parse(
    runCli(
      "__service-preflight",
      "--database-path",
      NodePath.join(state, "userdata/statev2.sqlite"),
      "--launcher-protocol",
      String(protocol),
    ),
  );
NodeAssert.equal(preflight(3).status, "blocked");
NodeAssert.equal(preflight(4).status, "ready");
// Existing npm services call this entry directly during preflight.
const legacyPreflight = JSON.parse(
  NodeChildProcess.execFileSync(
    process.execPath,
    [
      NodePath.join(install, "node_modules/@styal/cli/dist/bin.mjs"),
      "__service-preflight",
      "--database-path",
      NodePath.join(state, "userdata/statev2.sqlite"),
      "--launcher-protocol",
      "3",
    ],
    { env, encoding: "utf8", timeout: 60_000 },
  ),
);
NodeAssert.equal(legacyPreflight.status, "blocked");
NodeAssert.match(legacyPreflight.reason, /service update/);
runCli("project", "add", project, "--title", "CLI verification", "--base-dir", state);

// Exercise the native dependency from the downloaded archive, not a workspace copy.
const require = NodeModule.createRequire(NodePath.join(runtimeDir, "package.json"));
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

const listener = NodeNet.createServer();
listener.listen(0, "127.0.0.1");
await NodeEvents.once(listener, "listening");
const port = listener.address().port;
await new Promise((resolve, reject) =>
  listener.close((error) => (error ? reject(error) : resolve())),
);
const origin = `http://127.0.0.1:${port}`;
async function exerciseServer(iteration) {
  const server = NodeChildProcess.spawn(
    cli,
    ["serve", "--host", "127.0.0.1", "--port", String(port), "--no-browser", "--base-dir", state],
    { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] },
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
    const snapshot = await fetch(`${origin}/api/projects`, { headers: { cookie } });
    NodeAssert.equal(snapshot.status, 200);
    NodeAssert.match(snapshot.headers.get("content-type") ?? "", /application\/json/i);
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
NodeAssert.ok(NodeFS.readFileSync(NodePath.join(state, "userdata/statev2.sqlite")).length > 0);
console.log(
  "CLI launcher verified: install, verified archive download, executable, launcher compatibility, native terminal, pairing, and persistence across restart.",
);
