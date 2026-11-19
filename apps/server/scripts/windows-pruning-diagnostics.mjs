/* oxlint-disable t3code/namespace-node-imports, t3code/no-global-process-runtime -- Temporary isolated runner diagnostics. */
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
const root = process.env.EVENT_PRUNING_DIAGNOSTICS_ROOT;
assert(root, "explicit isolated root required");
fs.mkdirSync(root, { recursive: true });
const fixtureScript =
  process.env.EVENT_PRUNING_DIAGNOSTICS_FIXTURE ??
  "apps/server/scripts/windows-event-pruning-fixture.mjs";
const results = [];
const redact = (text) =>
  text.replace(/(pairingUrl:\s*)[^\r\n]+/g, "$1[synthetic pairing URL omitted]");
async function until(work) {
  const end = Date.now() + 120000;
  while (Date.now() < end) {
    if (await work()) return;
    await delay(50);
  }
  throw new Error("diagnostic observation deadline");
}
for (const enabled of [false, true]) {
  const label = enabled ? "on" : "off";
  const home = path.join(root, label + "-synthetic-home");
  const file = path.join(home, "userdata", "statev2.sqlite");
  const env = {
    ...process.env,
    T3CODE_EVENT_PRUNING: enabled ? "1" : "0",
    T3CODE_DEV_SEED: "0",
    T3CODE_TELEMETRY_ENABLED: "false",
    T3CODE_DISABLE_AUTO_UPDATE: "true",
    T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
  };
  delete env.T3CODE_PORT;
  const seed = spawnSync(process.execPath, [fixtureScript, "seed", file, "small"], {
    encoding: "utf8",
    env: { ...env, T3CODE_EVENT_PRUNING: "0" },
  });
  fs.writeFileSync(path.join(root, label + "-seed.log"), redact(seed.stdout + seed.stderr));
  assert.equal(seed.status, 0, "synthetic fixture failed");
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(
    process.execPath,
    [
      "apps/server/src/bin.ts",
      "start",
      "--base-dir",
      home,
      "--port",
      String(port),
      "--host",
      "127.0.0.1",
      "--no-browser",
    ],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      output += String(chunk);
    });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const requestResults = [];
  try {
    await until(async () => {
      assert.equal(child.exitCode, null, "synthetic server exited before readiness");
      try {
        const response = await fetch(`http://127.0.0.1:${port}/.well-known/t3/environment`, {
          signal: AbortSignal.timeout(1000),
        });
        requestResults.push({ status: response.status });
        await response.arrayBuffer();
        return response.ok;
      } catch (error) {
        requestResults.push({ error: error.name });
        return false;
      }
    });
    // Repeat the previous experiment's short client deadline after HTTP starts.
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/.well-known/t3/environment`, {
          signal: AbortSignal.timeout(1),
        });
        await response.arrayBuffer();
      } catch {
        /* Expected cancellation is the diagnostic under investigation. */
      }
    }
    const manifest = path.join(home, "userdata", "backups", "pre-event-prune", "manifest.json");
    if (enabled)
      await until(
        () =>
          fs.existsSync(manifest) &&
          fs.existsSync(path.join(path.dirname(manifest), "statev2.sqlite")),
      );
    else assert(!fs.existsSync(manifest), "pruning-off unexpectedly copied");
    await fetch(`http://127.0.0.1:${port}/.well-known/t3/environment`, {
      signal: AbortSignal.timeout(30000),
    }).then((response) => response.arrayBuffer());
    // Allow pipe data for already-aborted requests to reach the collector.
    await delay(250);
    const blocks = output
      .split(/(?=\[\d{2}:\d{2}:\d{2}\.\d+\])/)
      .filter((block) => /errorTag: '(?:PlatformError|Interrupt)'/.test(block));
    results.push({
      label,
      platform: process.platform,
      pid: child.pid,
      requests: requestResults,
      safetyCopy: fs.existsSync(manifest),
      diagnostics: blocks.map(redact),
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 5000);
      await exited;
      clearTimeout(force);
    }
    fs.writeFileSync(path.join(root, label + "-server.log"), redact(output));
    fs.writeFileSync(path.join(root, "results.json"), JSON.stringify(results, null, 2));
  }
}
console.log(JSON.stringify(results, null, 2));
