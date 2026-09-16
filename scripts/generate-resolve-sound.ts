#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Standalone asset generator using only Node builtins.

import * as NodeFS from "node:fs";

// Render the original B4 → C5 chime with its quiet octave harmonic and baked-in fades.
const tones = [
  {
    frequencyHz: 493.88,
    offsetSeconds: 0,
    durationSeconds: 0.17,
    attackSeconds: 0.018,
    releaseSeconds: 0.06,
    peakGain: 0.126,
    sustainRatio: 0.2,
  },
  {
    frequencyHz: 523.25,
    offsetSeconds: 0.13,
    durationSeconds: 0.33,
    attackSeconds: 0.022,
    releaseSeconds: 0.12,
    peakGain: 0.177,
    sustainRatio: 0.22,
  },
  {
    frequencyHz: 1046.5,
    offsetSeconds: 0.13,
    durationSeconds: 0.22,
    attackSeconds: 0.024,
    releaseSeconds: 0.09,
    peakGain: 0.017,
    sustainRatio: 0.12,
  },
];

const sampleRate = 48_000;
const duration = Math.max(...tones.map((tone) => tone.offsetSeconds + tone.durationSeconds)) + 0.02;
const samples = new Float64Array(Math.round(duration * sampleRate));

for (const tone of tones) {
  const offset = Math.round(tone.offsetSeconds * sampleRate);
  const length = Math.round(tone.durationSeconds * sampleRate);
  const releaseStart = tone.durationSeconds - tone.releaseSeconds;
  for (let i = 0; i < length; i++) {
    const time = i / sampleRate;
    const gain =
      time < tone.attackSeconds
        ? tone.peakGain * (time / tone.attackSeconds)
        : time < releaseStart
          ? tone.peakGain *
            tone.sustainRatio ** ((time - tone.attackSeconds) / (releaseStart - tone.attackSeconds))
          : tone.peakGain *
            tone.sustainRatio *
            ((tone.durationSeconds - time) / tone.releaseSeconds);
    samples[offset + i] =
      samples[offset + i]! + gain * Math.sin(2 * Math.PI * tone.frequencyHz * time);
  }
}

// Standard RIFF/WAVE header for mono, 16-bit PCM. No normalization: retain the authored volume.
const wav = Buffer.alloc(44 + samples.length * 2);
wav.write("RIFF", 0);
wav.writeUInt32LE(wav.length - 8, 4);
wav.write("WAVE", 8);
wav.write("fmt ", 12);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); // PCM
wav.writeUInt16LE(1, 22); // Mono
wav.writeUInt32LE(sampleRate, 24);
wav.writeUInt32LE(sampleRate * 2, 28);
wav.writeUInt16LE(2, 32); // Bytes per frame
wav.writeUInt16LE(16, 34); // Bits per sample
wav.write("data", 36);
wav.writeUInt32LE(samples.length * 2, 40);
for (let i = 0; i < samples.length; i++) {
  wav.writeInt16LE(Math.round(samples[i]! * 32767), 44 + i * 2);
}

NodeFS.writeFileSync(new URL("../apps/web/public/resolve.wav", import.meta.url), wav);
