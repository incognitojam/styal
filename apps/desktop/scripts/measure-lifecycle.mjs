import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveElectronBinaryPath } from "./electron-launcher.mjs";
import { seedLifecycleFixture } from "./lifecycle/seed.mjs";

const root = NodeURL.fileURLToPath(new URL("../../..", import.meta.url));
const platform = await Effect.runPromise(HostProcess.Platform);
const architecture = await Effect.runPromise(HostProcess.Architecture);
NodeAssert.equal(platform, "linux", "Lifecycle measurement currently isolates Linux only");
const { values } = NodeUtil.parseArgs({
  options: {
    samples: { type: "string", default: "5" },
    "settle-ms": { type: "string", default: "0" },
  },
});
const samples = Number(values.samples);
const settleMs = Number(values["settle-ms"]);
NodeAssert.ok(
  Number.isInteger(settleMs) && settleMs >= 0 && settleMs <= 30_000,
  "Use 0–30000 settle milliseconds",
);
NodeAssert.ok(Number.isInteger(samples) && samples >= 1 && samples <= 50, "Use 1–50 samples");
NodeAssert.equal(
  NodeChildProcess.spawnSync("git", ["check-ignore", "-q", ".scratch/"], { cwd: root }).status,
  0,
  "Ignore .scratch/ in .git/info/exclude before measuring",
);
await NodeFSP.access(NodePath.join(root, "apps/desktop/dist-electron/boot.cjs"));
await NodeFSP.access(NodePath.join(root, "apps/server/dist/client/index.html"));
const output = await NodeFSP.mkdtemp(NodePath.join(root, ".scratch/lifecycle-"));
const electron = resolveElectronBinaryPath();
const workspace = NodePath.join(output, "workspace");
await NodeFSP.mkdir(workspace);
NodeAssert.equal(NodeChildProcess.spawnSync("git", ["init", "--quiet", workspace]).status, 0);
const environment = Object.fromEntries(
  [
    "PATH",
    "HOME",
    "SHELL",
    "USER",
    "LANG",
    "LC_ALL",
    "DISPLAY",
    "XAUTHORITY",
    "DBUS_SESSION_BUS_ADDRESS",
    "XDG_RUNTIME_DIR",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
  ].flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])),
);
const cancellation = new AbortController();
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
]) {
  process.once(signal, () => {
    process.exitCode = code;
    cancellation.abort(new Error(`Lifecycle measurement interrupted by ${signal}`));
  });
}

async function unusedPort() {
  const server = NodeNet.createServer();
  server.listen(0, "127.0.0.1");
  await NodeEvents.once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

function killOwnedProcess(pid) {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function runSample(scenario, state, iteration) {
  cancellation.signal.throwIfAborted();
  const directory = NodePath.join(output, `${scenario}-${iteration}`);
  await NodeFSP.mkdir(directory);
  const port = await unusedPort();
  const traceFiles = ["desktop.trace.ndjson", "server.trace.ndjson"];
  // Reset traces while stopped so rotation cannot invalidate a previous sample's offset.
  await Promise.all(
    traceFiles.map((file) =>
      NodeFSP.rm(NodePath.join(state, "userdata/logs", file), { force: true }),
    ),
  );
  const log = await NodeFSP.open(NodePath.join(directory, "app.log"), "w");
  const events = [];
  const pids = new Set();
  const launchedAt = performance.now();
  const child = NodeChildProcess.spawn(
    electron,
    [
      "--no-sandbox",
      "--disable-gpu",
      NodePath.join(root, "apps/desktop/scripts/lifecycle/app.cjs"),
    ],
    {
      cwd: root,
      env: {
        ...environment,
        STYAL_HOME: state,
        STYAL_LIFECYCLE_SAMPLE: directory,
        XDG_CONFIG_HOME: NodePath.join(state, "config"),
        XDG_DATA_HOME: NodePath.join(state, "data"),
        XDG_CACHE_HOME: NodePath.join(state, "cache"),
        T3CODE_PORT: String(port),
        T3CODE_DISABLE_AUTO_UPDATE: "true",
        T3CODE_TELEMETRY_ENABLED: "false",
        T3CODE_DESKTOP_PROTOCOL_REGISTRATION_MANAGED: "1",
      },
      stdio: ["ignore", log.fd, log.fd, "ipc"],
    },
  );
  let quitRequestedAt;
  let quitTimer;
  let timedOut = false;
  let validationStage = "startup";
  let processExit;
  const traces = [];
  const deadline = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 45_000);
  child.on("message", (event) => {
    events.push(event);
    if (event.event === "child-spawned") pids.add(event.pid);
    if (event.event === "ui-ready") {
      const quit = () => {
        quitRequestedAt = performance.now();
        child.send("quit");
      };
      if (settleMs === 0) quit();
      else quitTimer = setTimeout(quit, settleMs);
    }
  });
  try {
    const [code, signal] = await NodeEvents.once(child, "exit", { signal: cancellation.signal });
    processExit = { code, signal };
    const exitAt = performance.now();
    validationStage = "graceful-exit";
    NodeAssert.ok(!timedOut, "Sample exceeded 45 seconds");
    NodeAssert.equal(signal, null, "App must exit without a signal");
    NodeAssert.equal(code, 0, "App must exit successfully");
    NodeAssert.ok(quitRequestedAt !== undefined, "Client never reached connected shell readiness");
    NodeAssert.ok(
      events.some((event) => event.event === "will-quit"),
      "Graceful quit was not observed",
    );
    NodeAssert.ok(
      !events.some((event) =>
        ["renderer-error", "renderer-crashed", "uncaught-error"].includes(event.event),
      ),
      "App reported runtime errors; inspect events.json and app.log",
    );
    NodeAssert.ok(pids.size > 0, "No owned backend process was observed");
    const backends = events.filter((event) => event.event === "child-spawned" && event.backend);
    NodeAssert.equal(backends.length, 1, "Backend must start exactly once without restarting");
    for (const backend of backends) {
      const exit = events.find(
        (event) => event.event === "child-exited" && event.pid === backend.pid,
      );
      NodeAssert.ok(exit, "Backend exit was not acknowledged");
      // NodeRuntime.runMain exits 130 after its signal-driven interruption and finalizers.
      NodeAssert.ok(exit.code === 0 || exit.code === 130, "Backend exited unexpectedly");
      NodeAssert.equal(exit.signal, null, "Backend must exit without force-kill");
    }
    for (const pid of pids) NodeAssert.ok(!alive(pid), `App left child ${pid} running`);
    validationStage = "port-release";
    const probe = NodeNet.createServer();
    probe.listen(port, "127.0.0.1");
    await NodeEvents.once(probe, "listening");
    await new Promise((resolve) => probe.close(resolve));
    validationStage = "traces";
    for (const file of traceFiles) {
      const contents = await NodeFSP.readFile(NodePath.join(state, "userdata/logs", file));
      const text = contents.toString("utf8");
      const records = text
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      traces.push(...records);
      await NodeFSP.writeFile(NodePath.join(directory, file), text);
    }
    const errors = traces.flatMap((span) =>
      (span.events ?? [])
        .filter((event) => event.attributes?.["effect.logLevel"] === "ERROR")
        .map((event) => ({ span: span.name, event: event.name })),
    );
    await NodeFSP.writeFile(
      NodePath.join(directory, "error-events.json"),
      JSON.stringify(errors, null, 2),
    );
    NodeAssert.equal(errors.length, 0, "Application logged errors; inspect local traces");
    for (const name of [
      "ServerRuntimeStartup.prepareForShutdown",
      "shutdown.background",
      "shutdown.analytics",
    ]) {
      NodeAssert.ok(
        traces.some((span) => span.name === name && span.exit?._tag === "Success"),
        `Backend did not complete ${name}`,
      );
    }
    const result = {
      scenario,
      iteration,
      settleMs,
      readyMs: events.find((event) => event.event === "ui-ready").elapsedMs,
      bundleLoadedMs: events.find((event) => event.event === "bundle-loaded")?.elapsedMs,
      rendererLoadedMs: events.find((event) => event.event === "renderer-loaded")?.elapsedMs,
      windowShownMs: events.find((event) => event.event === "window-shown")?.elapsedMs,
      quitToExitMs: exitAt - quitRequestedAt,
      elapsedMs: exitAt - launchedAt,
      preparationPasses: traces.filter(
        (span) => span.name === "ServerRuntimeStartup.prepareForShutdown",
      ).length,
      slowestSpans: traces
        .filter((span) => span.type === "effect-span")
        .sort((a, b) => b.durationMs - a.durationMs)
        .slice(0, 15)
        .map(({ name, durationMs }) => ({ name, durationMs })),
    };
    await NodeFSP.writeFile(
      NodePath.join(directory, "result.json"),
      JSON.stringify(result, null, 2),
    );
    validationStage = "complete";
    console.log(
      `${scenario} ${iteration}: ready ${result.readyMs.toFixed(0)}ms; quit ${result.quitToExitMs.toFixed(0)}ms; preparation passes ${result.preparationPasses}`,
    );
    return result;
  } finally {
    clearTimeout(deadline);
    clearTimeout(quitTimer);
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await NodeEvents.once(child, "exit");
    }
    for (const pid of pids) {
      if (alive(pid)) killOwnedProcess(pid);
    }
    await log.close();
    await NodeFSP.writeFile(
      NodePath.join(directory, "events.json"),
      JSON.stringify(events, null, 2),
    );
    await NodeFSP.writeFile(
      NodePath.join(directory, "diagnostics.json"),
      JSON.stringify(
        {
          validationStage,
          timedOut,
          processExit,
          interrupted: cancellation.signal.aborted,
          failedSpans: traces
            .filter((span) => span.exit?._tag === "Failure")
            .slice(0, 100)
            .map(({ name, durationMs }) => ({ name, durationMs })),
        },
        null,
        2,
      ),
    );
  }
}

const results = [];
const buildHash = NodeCrypto.createHash("sha256");
for (const directory of ["apps/desktop/dist-electron", "apps/server/dist"]) {
  for (const name of (await NodeFSP.readdir(NodePath.join(root, directory))).sort()) {
    if (!/\.(?:cjs|mjs)$/.test(name)) continue;
    buildHash.update(name).update(await NodeFSP.readFile(NodePath.join(root, directory, name)));
  }
}
console.log(`Lifecycle artifacts: ${output}`);
try {
  for (const scenario of ["empty", "populated"]) {
    const state = NodePath.join(output, scenario, "state");
    await NodeFSP.mkdir(NodePath.join(state, "userdata"), { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(state, "userdata/client-settings.json"),
      JSON.stringify({
        onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    await NodeFSP.writeFile(
      NodePath.join(state, "userdata/settings.json"),
      JSON.stringify({ autoUpdateProviders: false }),
    );
    results.push(await runSample(`${scenario}-initialize`, state, 0));
    if (scenario === "populated") await seedLifecycleFixture(state, workspace);
    for (let index = 1; index <= samples; index++)
      results.push(await runSample(scenario, state, index));
  }
} finally {
  await NodeFSP.writeFile(
    NodePath.join(output, "measurements.json"),
    JSON.stringify(
      {
        version: 1,
        revision: NodeChildProcess.spawnSync("git", ["rev-parse", "HEAD"], {
          cwd: root,
          encoding: "utf8",
        }).stdout.trim(),
        platform,
        arch: architecture,
        samples,
        settleMs,
        buildHash: buildHash.digest("hex"),
        fixture: "completed V2 history projections; no event replay or active provider sessions",
        results,
      },
      null,
      2,
    ),
  );
}
