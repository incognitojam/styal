/* oxlint-disable t3code/namespace-node-imports, t3code/no-global-process-runtime -- Temporary standalone runner experiment. */
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
if (process.argv[2] === "fixture") {
  process.argv.splice(2, 1);
  await import("./windows-event-pruning-fixture.mjs");
  process.exit(0);
}
const root = process.env.EVENT_PRUNING_EXPERIMENT_ROOT;
assert(root, "explicit experiment root required");
fs.mkdirSync(root, { recursive: true });
const dataRoot = fs.mkdtempSync(path.join(root, "synthetic-"));
const report = [];
const log = (value) => {
  report.push(value);
  console.log(JSON.stringify(value));
  fs.writeFileSync(path.join(root, "summary.txt"), report.map((x) => JSON.stringify(x)).join("\n"));
};
const fixture = (mode, file, size) => {
  const r = spawnSync(
    process.execPath,
    [
      "apps/server/scripts/windows-event-pruning.mjs",
      "fixture",
      mode,
      file,
      ...(size ? [size] : []),
    ],
    { encoding: "utf8", env: { ...process.env, T3CODE_EVENT_PRUNING: "0" } },
  );
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return JSON.parse(r.stdout.trim().split("\n").at(-1));
};
const read = (file, sql) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
};
const count = (file) => read(file, "SELECT COUNT(*) n FROM orchestration_events")[0].n;
const traceDirectory = path.join(root, "sql-trace");
// A static import keeps the experiment-only preload visible to the dependency checker.
await import("./windows-event-pruning-trace.mjs");
function traceSpans() {
  return fs.existsSync(traceDirectory)
    ? fs.readdirSync(traceDirectory).flatMap((name) =>
        fs
          .readFileSync(path.join(traceDirectory, name), "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      )
    : [];
}
function beginProbes(file, size, serverPid) {
  const target = path.join(root, `probes-${size}.jsonl`);
  const worker = new Worker(
    String.raw`
    const {parentPort,workerData}=require('node:worker_threads');
    const {DatabaseSync}=require('node:sqlite');
    const fs=require('node:fs');
    const db=new DatabaseSync(workerData.file);
    db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS experiment_write_probe (value INTEGER)');

    const checkpoint=db.prepare('PRAGMA wal_checkpoint(NOOP)');
    let stopping=false;
    parentPort.on('message',()=>{stopping=true;});
    async function run() {
      try {
        while(!stopping) {
          const before=checkpoint.get();
          const start=performance.timeOrigin+performance.now();
          db.exec('INSERT INTO experiment_write_probe VALUES (1)');
          const end=performance.timeOrigin+performance.now();
          const after=checkpoint.get();
          fs.appendFileSync(workerData.target,JSON.stringify({start,end,latencyMs:end-start,checkpointBefore:before,checkpointAfter:after})+'\n');
          await new Promise(resolve=>setTimeout(resolve,50));
        }
      } finally {db.close();}
    }
    run().then(()=>parentPort.close()).catch(error=>{throw error;});
  `,
    { eval: true, workerData: { file, target } },
  );
  const exited = new Promise((resolve, reject) => {
    worker.once("error", reject);
    worker.once("exit", (code) =>
      code === 0 ? resolve() : reject(Error(`probe worker exited ${code}`)),
    );
  });
  exited.catch(() => {});
  return {
    async finish(manifest) {
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node worker threads have no browser origin.
      worker.postMessage("stop");
      await exited;
      const spans = traceSpans().filter((span) => span.pid === serverPid);
      const probes = fs
        .readFileSync(target, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const probe = JSON.parse(line);
          const overlapping = spans.filter(
            (span) => span.start <= probe.end && span.end >= probe.start,
          );
          const explicitCheckpoint = overlapping.some((span) => span.phase === "checkpoint");
          const framesAdvanced =
            probe.checkpointBefore.busy === 0 &&
            probe.checkpointAfter.busy === 0 &&
            probe.checkpointBefore.checkpointed >= 0 &&
            probe.checkpointAfter.checkpointed >= 0 &&
            probe.checkpointAfter.checkpointed > probe.checkpointBefore.checkpointed;
          const deletePass =
            probe.start <= manifest.firstDeleteCompletedAt &&
            probe.end >= manifest.firstDeleteStartedAt;
          const phase =
            explicitCheckpoint || framesAdvanced
              ? "checkpoint"
              : deletePass
                ? "delete pass"
                : probe.start > manifest.firstDeleteCompletedAt
                  ? "after delete pass"
                  : "waiting for compaction";
          return {
            ...probe,
            at: new Date(probe.start).toISOString(),
            phase,
            deletePass,
            checkpointEvidence: explicitCheckpoint
              ? "overlapping instrumented checkpoint"
              : framesAdvanced
                ? "checkpoint frame advancement (may be automatic or concurrent)"
                : "none",
            sqlSpans: overlapping,
          };
        });
      fs.writeFileSync(target, probes.map((probe) => JSON.stringify(probe)).join("\n") + "\n");
      const maxima = Object.fromEntries(
        [
          "copy",
          "verification",
          "waiting for compaction",
          "delete pass",
          "checkpoint",
          "after delete pass",
        ].map((phase) => {
          const samples = probes.filter((probe) => probe.phase === phase);
          const slowest = samples.reduce(
            (max, probe) => (!max || probe.latencyMs > max.latencyMs ? probe : max),
            null,
          );
          return [
            phase,
            {
              count: samples.length,
              maxMs: slowest?.latencyMs ?? null,
              at: slowest?.at ?? null,
              checkpointEvidence: slowest?.checkpointEvidence ?? null,
            },
          ];
        }),
      );
      log({
        size,
        check: "phase-tagged foreground probes",
        maxima,
        startupWrites: "not attempted: normal runtime waits for verified copy",
        instrumentedCheckpointSpans: spans.filter((span) => span.phase === "checkpoint").length,
      });
      return probes;
    },
  };
}
const children = new Set();
function start(home, port) {
  const started = performance.now();
  const p = spawn(
    process.execPath,
    [
      "--import",
      pathToFileURL(path.resolve("apps/server/scripts/windows-event-pruning-trace.mjs")).href,
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
    {
      env: {
        ...process.env,
        T3CODE_EVENT_PRUNING: "1",
        EVENT_PRUNING_SQL_TRACE_DIR: traceDirectory,
        T3CODE_TELEMETRY_ENABLED: "false",
        T3CODE_DISABLE_AUTO_UPDATE: "true",
        T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.add(p);
  let output = "";
  const lines = [];
  for (const stream of [p.stdout, p.stderr])
    stream.on("data", (data) => {
      const text = String(data);
      output += text;
      for (const line of text.split("\n"))
        if (/Making a safety copy|Safety copy|Compacted orchestration|prun|Error|error/.test(line))
          lines.push({ ms: performance.now() - started, text: line });
    });
  p.on("exit", () => children.delete(p));
  return { p, started, lines, output: () => output, port };
}
async function until(fn, ms = 180000) {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    const value = await fn();
    if (value) return value;
    await delay(50);
  }
  throw Error("experiment observation deadline");
}
async function stop(s) {
  if (s.p.exitCode !== null || s.p.signalCode !== null) return;
  const exited = new Promise((resolve) => s.p.once("exit", resolve));
  s.p.kill("SIGTERM");
  const timer = setTimeout(() => s.p.kill("SIGKILL"), 5000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}
async function ready(s) {
  return until(async () => {
    if (s.p.exitCode !== null) throw Error(s.lines.map((x) => x.text).join("\n"));
    try {
      const r = await fetch(`http://127.0.0.1:${s.port}/.well-known/t3/environment`, {
        signal: AbortSignal.timeout(1000),
      });
      if (r.status === 503) {
        const state = await r.json().catch(() => null);
        if (state?.copy && !s.progress)
          s.progress = {
            ms: performance.now() - s.started,
            ...state.copy,
            walBytes: fs.existsSync(s.file + "-wal") ? fs.statSync(s.file + "-wal").size : 0,
          };
      }
      return r.ok;
    } catch {
      return false;
    }
  });
}
try {
  log({
    node: process.version,
    sqlite: read(":memory:", "SELECT sqlite_version() version"),
    platform: process.platform,
    runner: process.env.ImageOS,
    image: process.env.ImageVersion,
  });
  for (const [index, size] of ["small", "large"].entries()) {
    const home = path.join(dataRoot, `${size} synthetic home with spaces`),
      file = path.join(home, "userdata", "statev2.sqlite"),
      backup = path.join(path.dirname(file), "backups", "pre-event-prune"),
      manifest = path.join(backup, "manifest.json");
    log(fixture("seed", file, size));
    const before = fixture("dump", file);
    const events = count(file);
    if (size === "large" && process.platform === "win32") {
      const interrupted = start(home, 43003);
      try {
        await until(() => {
          const staging = path.join(backup, "statev2.sqlite.staging");
          if (!fs.existsSync(staging)) return false;
          const bytes = fs.statSync(staging).size;
          return bytes > 0 && bytes < fs.statSync(file).size ? { bytes } : false;
        });
        await stop(interrupted);
        assert(!fs.existsSync(manifest));
        assert.equal(count(file), events);
        log({
          size,
          check: "stopped mid-copy",
          eventsUnchanged: true,
          stagingRemains: fs.existsSync(path.join(backup, "statev2.sqlite.staging")),
        });
      } finally {
        await stop(interrupted);
      }
    }
    const s = start(home, 43001 + index);
    s.file = file;
    const readiness = ready(s).then(() => performance.now() - s.started);
    readiness.catch(() => {});
    let copyStart, copyEnd;
    try {
      await until(() => {
        if (s.p.exitCode !== null) throw Error(s.lines.map((x) => x.text).join("\n"));
        const line =
          s.lines.find((x) => /verified and saved/.test(x.text)) ??
          (fs.existsSync(manifest) && fs.existsSync(path.join(backup, "statev2.sqlite"))
            ? { ms: performance.now() - s.started }
            : undefined);
        if (line) {
          copyEnd = line.ms;
          copyStart = s.lines.find((x) => /Making a safety copy/i.test(x.text))?.ms;
          return true;
        }
        return false;
      });
      const m = JSON.parse(fs.readFileSync(manifest, "utf8"));
      assert.equal(m.method, process.platform === "win32" ? "copy" : m.method);
      assert.equal(m.eventCount, events);
      assert.equal(count(path.join(backup, "statev2.sqlite")), events);
      assert.equal(fs.statSync(path.join(backup, "statev2.sqlite")).size, m.sourceSize);
      assert.equal(
        read(path.join(backup, "statev2.sqlite"), "PRAGMA integrity_check")[0].integrity_check,
        "ok",
      );
      const startupMs = await readiness;
      assert(startupMs < 180000);
      log({
        size,
        check: "copy and startup",
        copyStartMs: copyStart,
        verifiedMs: copyEnd,
        startupMs,
        manifest: m,
        backupPathLength: path.join(backup, "statev2.sqlite").length,
        progress: s.progress,
      });
      const competing = start(home, 43004);
      try {
        await until(() => competing.p.exitCode !== null);
        assert.equal(s.p.exitCode, null);
        log({
          size,
          check: "two close starts",
          secondExit: competing.p.exitCode,
          firstStillRunning: true,
          lines: competing.lines,
        });
      } finally {
        await stop(competing);
      }
      const probes = beginProbes(file, size, s.p.pid);
      const pruneWait = performance.now();
      let writes;
      try {
        await until(() => fs.existsSync(path.join(path.dirname(file), "compacted-at")), 240000);
      } finally {
        writes = await probes.finish(JSON.parse(fs.readFileSync(manifest, "utf8")));
      }
      const remaining = count(file);
      assert(remaining < events);
      const after = fixture("dump", file);
      assert.deepEqual(after, before);
      log({
        size,
        check: "prune and client snapshots",
        deleted: events - remaining,
        deletePassMs: (() => {
          const m = JSON.parse(fs.readFileSync(manifest, "utf8"));
          return m.firstDeleteCompletedAt - m.firstDeleteStartedAt;
        })(),
        remaining,
        waitForPruneMs: performance.now() - pruneWait,
        maxProbeWriteMs: Math.max(...writes.map((probe) => probe.latencyMs)),
        snapshot: before,
        lines: s.lines,
      });
    } finally {
      await stop(s);
    }
    const stoppedDb = new DatabaseSync(file);
    assert.equal(stoppedDb.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get().busy, 0);
    stoppedDb.close();
    fs.copyFileSync(file, path.join(home, "saved-current.sqlite"));
    fs.copyFileSync(path.join(backup, "statev2.sqlite"), file);
    for (const suffix of ["-wal", "-shm"]) fs.rmSync(file + suffix, { force: true });
    assert.equal(count(file), events);
    assert.deepEqual(fixture("dump", file), before);
    const restored = start(home, 43001 + index);
    try {
      await ready(restored);
      await until(() => /Restored database detected/.test(restored.output()));
      assert.equal(count(file), events);
      log({ size, check: "documented restore", events, snapshot: before, lines: restored.lines });
    } finally {
      await stop(restored);
    }
  }
  log({
    check: "packaged desktop",
    result:
      "skipped: launch check requires unpacked application produced by full packaging pipeline; no installer built",
  });
} catch (error) {
  log({ failure: String(error), stack: error.stack });
  process.exitCode = 1;
} finally {
  for (const p of children) p.kill("SIGTERM");
}
