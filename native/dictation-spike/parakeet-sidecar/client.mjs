// Streams a wav to the dictation endpoint at real-time pace and reports the
// latency a user would actually perceive.
//
//   node client.mjs http://127.0.0.1:8799/dictate <audio> [--fast]
//
// Measures two things that matter:
//   firstUpdateMs  — time from starting to speak until the first text appears
//   tailMs         — time from the last audio frame until the final transcript,
//                    which is the wait after you stop talking

import { spawn } from "node:child_process";

const [, , url, input, ...flags] = process.argv;
if (!url || !input) {
  console.error("usage: node client.mjs <url> <audio> [--fast]");
  process.exit(2);
}
const realtime = !flags.includes("--fast");

const SAMPLE_RATE = 16000;
const FRAME_BYTES = 1600 * 4;

const ffmpeg = spawn("ffmpeg", [
  "-v", "error", "-i", input,
  "-ar", String(SAMPLE_RATE), "-ac", "1", "-f", "f32le", "-",
]);
const chunks = [];
for await (const chunk of ffmpeg.stdout) chunks.push(chunk);
const pcm = Buffer.concat(chunks);
const audioMs = (pcm.length / 4 / SAMPLE_RATE) * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let started = 0;
let lastFrameAt = 0;

async function* frames() {
  started = Date.now();
  for (let offset = 0; offset + FRAME_BYTES <= pcm.length; offset += FRAME_BYTES) {
    yield pcm.subarray(offset, offset + FRAME_BYTES);
    if (realtime) {
      const audioClock = ((offset + FRAME_BYTES) / 4 / SAMPLE_RATE) * 1000;
      const behind = audioClock - (Date.now() - started);
      if (behind > 0) await sleep(behind);
    }
  }
  lastFrameAt = Date.now();
}

const response = await fetch(url, {
  method: "POST",
  body: frames(),
  duplex: "half",
  headers: { "content-type": "application/octet-stream" },
});

let firstUpdateMs = null;
let updates = 0;
let finalText = "";
let pending = "";

for await (const chunk of response.body) {
  pending += Buffer.from(chunk).toString();
  const lines = pending.split("\n");
  pending = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    if (event.type === "update") {
      updates += 1;
      if (firstUpdateMs === null && (event.committed || event.tentative)) {
        firstUpdateMs = Date.now() - started;
      }
    } else if (event.type === "final") {
      finalText = event.text;
    }
  }
}

console.log(
  JSON.stringify({
    audioMs: Math.round(audioMs),
    firstUpdateMs,
    tailMs: Date.now() - lastFrameAt,
    totalMs: Date.now() - started,
    updates,
    text: finalText.slice(0, 80),
  }),
);
