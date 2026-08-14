// Paces a wav file into stdout as 16 kHz mono f32 PCM at real-time speed, so
// latency measured downstream reflects what a live microphone would produce.
//
//   node feed.mjs <audio> [--fast] | ./target/release/parakeet-sidecar <model.gguf>
//
// --fast feeds as quickly as the pipe accepts, which measures raw compute
// throughput instead of perceived latency.

import { spawn } from "node:child_process";

const [, , input, ...flags] = process.argv;
if (!input) {
  console.error("usage: node feed.mjs <audio> [--fast]");
  process.exit(2);
}
const realtime = !flags.includes("--fast");

const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 1600; // 100ms
const FRAME_BYTES = FRAME_SAMPLES * 4;

const ffmpeg = spawn("ffmpeg", [
  "-v", "error",
  "-i", input,
  "-ar", String(SAMPLE_RATE),
  "-ac", "1",
  "-f", "f32le",
  "-",
]);
ffmpeg.stderr.pipe(process.stderr);

const chunks = [];
for await (const chunk of ffmpeg.stdout) chunks.push(chunk);
const pcm = Buffer.concat(chunks);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const started = Date.now();

for (let offset = 0; offset + FRAME_BYTES <= pcm.length; offset += FRAME_BYTES) {
  process.stdout.write(pcm.subarray(offset, offset + FRAME_BYTES));
  if (realtime) {
    // Sleep only as far as the wall clock has fallen behind the audio clock, so
    // write() backpressure does not compound into drift.
    const audioMs = ((offset + FRAME_BYTES) / 4 / SAMPLE_RATE) * 1000;
    const behind = audioMs - (Date.now() - started);
    if (behind > 0) await sleep(behind);
  }
}
process.stdout.end();
