// Minimal stand-in for the T3 server's dictation endpoint.
//
// POST /dictate with a streaming body of raw 16 kHz mono f32 PCM. Responds with
// chunked JSONL: the sidecar's updates forwarded as they are produced.
//
// Deliberately raw HTTP rather than the WebSocket RPC: audio as base64 inside
// JSON would inflate 64 kB/s of PCM by a third, and apps/server already has raw
// HttpRouter routes (the OTLP proxy) to model this on.
//
//   node server.mjs <model.gguf> [port]

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const [, , modelPath, portArg] = process.argv;
if (!modelPath) {
  console.error("usage: node server.mjs <model.gguf> [port]");
  process.exit(2);
}
const port = Number(portArg ?? 8799);
const sidecarPath = join(here, "target", "release", "parakeet-sidecar");

// Model load is ~10.7s, so a sidecar is spawned ahead of time and replaced after
// each utterance. A real implementation would pool these; the point here is that
// per-request latency must never include a model load.
let warm = null;
function spawnWarm() {
  const sidecar = spawn(sidecarPath, [modelPath]);
  const ready = new Promise((resolve) => {
    const onData = (chunk) => {
      if (chunk.toString().includes('"ready"')) {
        sidecar.stdout.off("data", onData);
        resolve();
      }
    };
    sidecar.stdout.on("data", onData);
  });
  warm = { sidecar, ready };
  return warm;
}
spawnWarm().ready.then(() => console.error("[server] sidecar warm"));

createServer((request, response) => {
  if (request.method !== "POST" || !request.url.startsWith("/dictate")) {
    response.writeHead(404).end();
    return;
  }

  const requestStarted = Date.now();
  const { sidecar } = warm;
  spawnWarm(); // start the replacement loading immediately

  response.writeHead(200, {
    "content-type": "application/x-ndjson",
    "cache-control": "no-cache",
    // Without this, Node may buffer small writes and hide the streaming.
    "transfer-encoding": "chunked",
  });

  let pending = "";
  let firstUpdateAt = null;
  sidecar.stdout.on("data", (chunk) => {
    pending += chunk.toString();
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      if (firstUpdateAt === null) {
        try {
          if (JSON.parse(line).type === "update") firstUpdateAt = Date.now();
        } catch {}
      }
      response.write(line + "\n");
    }
  });

  sidecar.stderr.on("data", (chunk) => process.stderr.write(chunk));

  sidecar.on("close", () => {
    response.write(
      JSON.stringify({
        type: "server",
        totalMs: Date.now() - requestStarted,
        firstUpdateMs: firstUpdateAt === null ? null : firstUpdateAt - requestStarted,
      }) + "\n",
    );
    response.end();
  });

  // Client disconnecting mid-utterance must not leave an orphan sidecar.
  request.on("aborted", () => {
    console.error("[server] client aborted; killing sidecar");
    sidecar.kill("SIGKILL");
  });

  request.pipe(sidecar.stdin);
  request.on("error", () => sidecar.kill("SIGKILL"));
}).listen(port, () => console.error(`[server] listening on :${port}`));
