// One dictation utterance: microphone -> 16 kHz mono f32 PCM -> the server's
// /api/dictation/stream endpoint -> streamed transcript events.
//
// Capture happens here in the renderer so web and desktop share one
// implementation; transcription happens on the user's own T3 server (Parakeet
// via the t3-dictation sidecar). Audio never leaves infrastructure the user
// controls. Design: .plans/dictation.md.

import {
  readPrimaryEnvironmentTarget,
  resolvePrimaryEnvironmentHttpUrl,
} from "../environments/primary";

export const DICTATION_SAMPLE_RATE = 16000;
/** 100ms of audio per frame, matching the sidecar's read cadence. */
const FRAME_SAMPLES = 1600;

export type DictationEvent =
  | {
      readonly type: "ready";
      readonly backend: string;
      readonly loadMs: number;
    }
  | {
      readonly type: "update";
      readonly committed: string;
      readonly tentative: string;
      readonly audioMs: number;
      readonly rtf: number;
    }
  | {
      readonly type: "final";
      readonly text: string;
      readonly audioMs: number;
      readonly rtf: number;
    }
  | { readonly type: "error"; readonly message: string };

export interface DictationSessionHandle {
  /** Stops capture and lets the server finalize; resolves with the final text. */
  readonly stop: () => void;
  /** Abandons the utterance: kills capture and the request without inserting. */
  readonly cancel: () => void;
  readonly done: Promise<DictationSessionResult>;
}

export interface DictationSessionResult {
  readonly finalText: string | null;
  readonly error: string | null;
}

// An inline AudioWorklet posts fixed-size f32 frames back to the main thread.
// A Blob URL keeps the worklet self-contained instead of adding a build asset.
const WORKLET_SOURCE = `
class DictationCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(${FRAME_SAMPLES});
    this.filled = 0;
  }
  process(inputs) {
    this.calls = (this.calls ?? 0) + 1;
    const channel = inputs[0]?.[0];
    if (!channel) {
      this.empty = (this.empty ?? 0) + 1;
      if (this.calls % 128 === 0) this.port.postMessage({ stat: { calls: this.calls, empty: this.empty ?? 0 } });
      return true;
    }
    if (this.calls % 128 === 0) this.port.postMessage({ stat: { calls: this.calls, empty: this.empty ?? 0 } });
    let offset = 0;
    while (offset < channel.length) {
      const take = Math.min(channel.length - offset, this.buffer.length - this.filled);
      this.buffer.set(channel.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;
      if (this.filled === this.buffer.length) {
        this.port.postMessage(this.buffer.slice());
        this.filled = 0;
      }
    }
    return true;
  }
}
registerProcessor("dictation-capture", DictationCaptureProcessor);
`;

/** Digital-silence guard threshold; see spike finding 4. */
const SILENCE_PEAK_DBFS = -70;

export interface StartDictationOptions {
  readonly onEvent: (event: DictationEvent) => void;
  /** Peak level of the most recent capture frame, in dBFS. ~10Hz. */
  readonly onLevel?: (dbfs: number) => void;
}

// One microphone, one session, app-wide. Multiple composers can mount a
// dictation control (and the keybinding bus reaches all of them), so without a
// module-level guard one shortcut press starts overlapping sessions — a spare
// one keeps the mic open after another inserts and closes.
let liveSession: DictationSessionHandle | null = null;

export async function startDictationSession(
  options: StartDictationOptions,
): Promise<DictationSessionHandle> {
  if (liveSession !== null) {
    throw new Error("Dictation is already running.");
  }
  const abort = new AbortController();
  // A denied or broken microphone yields a full-length recording of digital
  // silence with no error anywhere in the chain (spike finding 4), so peak
  // level is tracked and surfaced when the whole utterance was silent.
  let peak = 0;
  // Worklet-side counters, so a silent capture pinpoints its own stage: zero
  // calls means the graph never pulled the node; empty calls mean the source
  // produced no channels; neither means samples were lost after capture.
  let workletStat: { calls: number; empty: number } | null = null;

  // No sampleRate constraint: a real macOS microphone can honor 16 kHz, and a
  // track whose rate differs from the AudioContext's renders silence in Chrome.
  // Track and context both stay at the hardware rate; resampling to the wire
  // format happens below.
  const media = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: { ideal: 1 },
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  // Deliberately at the microphone's native rate: Chrome renders silence from
  // MediaStreamAudioSourceNode when the context rate differs from the track's
  // hardware rate, so the 16 kHz the sidecar needs is resampled here instead.
  const audioContext = new AudioContext();
  const workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "text/javascript" }));
  try {
    await audioContext.audioWorklet.addModule(workletUrl);
  } finally {
    URL.revokeObjectURL(workletUrl);
  }
  // Created after an await, so user-activation may have lapsed and the context
  // can start suspended — in which case the worklet never runs.
  if (audioContext.state !== "running") {
    await audioContext.resume();
  }

  const source = audioContext.createMediaStreamSource(media);
  // The worklet must stay reachable from the destination or the audio graph
  // never pulls it and process() is simply never called — a zero-output node
  // silently captures nothing. It is kept in the graph through a muted gain so
  // nothing is audible.
  const capture = new AudioWorkletNode(audioContext, "dictation-capture", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
  });
  const mute = audioContext.createGain();
  mute.gain.value = 0;
  source.connect(capture);
  capture.connect(mute);
  mute.connect(audioContext.destination);

  // Transport is a WebSocket, not a streaming POST: browsers only permit
  // streaming fetch request bodies over HTTP/2 (Chrome fails HTTP/1.1 attempts
  // with ERR_ALPN_NEGOTIATION_FAILED), and the T3 server speaks HTTP/1.1.
  // Binary frames carry PCM; a text frame marks end-of-speech; the server sends
  // JSON text frames back and closes after "final".
  const socket = new WebSocket(await resolveDictationSocketUrl());
  socket.binaryType = "arraybuffer";

  // Frames captured before the socket opens are buffered so the first words
  // are never dropped while the connection establishes.
  const backlog: Uint8Array[] = [];
  let socketOpen = false;
  let endRequested = false;

  // A proxy that does not forward upgrades leaves the socket pending forever
  // with no error or close event; without a deadline the session would hang in
  // "finalizing" silently.
  let connectTimedOut = false;
  const connectDeadline = setTimeout(() => {
    if (!socketOpen) {
      connectTimedOut = true;
      options.onEvent({
        type: "error",
        message: "Dictation connection timed out before opening.",
      });
      socket.close();
    }
  }, 10_000);

  socket.addEventListener("open", () => {
    clearTimeout(connectDeadline);
    socketOpen = true;
    for (const frame of backlog) {
      socket.send(frame.buffer as ArrayBuffer);
    }
    backlog.length = 0;
    if (endRequested) {
      socket.send("end");
    }
  });

  const resampler = new LinearResampler(audioContext.sampleRate, DICTATION_SAMPLE_RATE);
  const framer = new FixedFramer(FRAME_SAMPLES);

  capture.port.onmessage = (
    message: MessageEvent<Float32Array | { stat: { calls: number; empty: number } }>,
  ) => {
    if (!(message.data instanceof Float32Array)) {
      workletStat = message.data.stat;
      return;
    }
    const samples = message.data;
    let framePeak = 0;
    for (let index = 0; index < samples.length; index += 1) {
      const magnitude = Math.abs(samples[index]!);
      if (magnitude > framePeak) {
        framePeak = magnitude;
      }
    }
    if (framePeak > peak) {
      peak = framePeak;
    }
    options.onLevel?.(dbfs(framePeak));
    for (const frame of framer.push(resampler.push(samples))) {
      const bytes = new Uint8Array(frame.buffer.slice(0, frame.length * 4));
      if (socketOpen && socket.readyState === WebSocket.OPEN) {
        socket.send(bytes.buffer as ArrayBuffer);
      } else if (!endRequested) {
        backlog.push(bytes);
      }
    }
  };

  let captureReleased = false;
  const releaseCapture = () => {
    // Runs from stop(), cancel() and the socket close handler; whichever comes
    // first wins, the rest are no-ops (closing a closed AudioContext throws).
    if (captureReleased) {
      return;
    }
    captureReleased = true;
    capture.port.onmessage = null;
    source.disconnect();
    capture.disconnect();
    mute.disconnect();
    for (const track of media.getTracks()) {
      track.stop();
    }
    void audioContext.close();
  };

  const STOP_LINGER_MS = 350;
  const finishEnd = () => {
    if (endRequested) {
      return;
    }
    endRequested = true;
    const tail = framer.flush();
    if (socketOpen && socket.readyState === WebSocket.OPEN) {
      if (tail !== null) {
        socket.send(new Uint8Array(tail.buffer.slice(0, tail.length * 4)).buffer as ArrayBuffer);
      }
      socket.send("end");
    } else if (tail !== null) {
      backlog.push(new Uint8Array(tail.buffer.slice(0, tail.length * 4)));
    }
    releaseCapture();
  };

  let stopRequested = false;
  const requestEnd = () => {
    // Users click stop on the last syllable, and the audio pipeline itself has
    // latency; releasing capture at the click reliably truncates the final
    // word. Capture continues briefly, then the partial frame flushes ahead of
    // the end marker.
    if (stopRequested || endRequested) {
      return;
    }
    stopRequested = true;
    setTimeout(finishEnd, STOP_LINGER_MS);
  };

  const done = new Promise<DictationSessionResult>((resolve) => {
    let finalText: string | null = null;
    let errorMessage: string | null = null;

    const settle = () => {
      releaseCapture();
      if (abort.signal.aborted) {
        resolve({ finalText: null, error: null });
        return;
      }
      if (
        errorMessage === null &&
        (finalText === null || finalText.trim().length === 0) &&
        dbfs(peak) < SILENCE_PEAK_DBFS
      ) {
        const track = media.getAudioTracks()[0];
        const trackRate = track?.getSettings().sampleRate ?? "?";
        const trackIdentity =
          track === undefined
            ? "no track"
            : `"${track.label}" muted=${track.muted} enabled=${track.enabled} state=${track.readyState}`;
        errorMessage =
          "No audio was captured. Check the microphone permission and input device. " +
          `(peak ${dbfs(peak).toFixed(1)} dBFS, context ${audioContext.state} @ ` +
          `${audioContext.sampleRate}Hz, track @ ${trackRate}Hz [${trackIdentity}], worklet ` +
          `${workletStat === null ? "no stats" : `${workletStat.calls} calls / ${workletStat.empty} empty`})`;
        options.onEvent({ type: "error", message: errorMessage });
      }
      resolve({
        finalText: errorMessage === null ? finalText : null,
        error: errorMessage,
      });
    };

    socket.addEventListener("message", (message: MessageEvent) => {
      if (typeof message.data !== "string") {
        return;
      }
      for (const line of message.data.split("\n")) {
        if (line.trim().length === 0) {
          continue;
        }
        const event = JSON.parse(line) as DictationEvent;
        if (event.type === "final") {
          finalText = event.text;
        }
        if (event.type === "error") {
          errorMessage = event.message;
        }
        options.onEvent(event);
      }
      if (finalText !== null || errorMessage !== null) {
        socket.close(1000);
      }
    });

    socket.addEventListener("close", (event) => {
      // A refused handshake (e.g. 503) closes without ever opening; the
      // connect deadline must not fire a second, misleading toast after it.
      clearTimeout(connectDeadline);
      if (connectTimedOut) {
        errorMessage = "Dictation connection timed out before opening.";
      } else if (
        finalText === null &&
        errorMessage === null &&
        !abort.signal.aborted &&
        event.code !== 1000
      ) {
        errorMessage = `Dictation connection closed (${event.code}${
          event.reason ? `: ${event.reason}` : ""
        }). Is a transcription model configured on the server?`;
        options.onEvent({ type: "error", message: errorMessage });
      }
      settle();
    });

    socket.addEventListener("error", () => {
      // The close event follows with the diagnostic; nothing useful here.
    });

    abort.signal.addEventListener("abort", () => {
      socket.close(1000);
    });
  });

  const handle: DictationSessionHandle = {
    stop: requestEnd,
    cancel: () => {
      releaseCapture();
      abort.abort();
    },
    done,
  };
  liveSession = handle;
  void done.finally(() => {
    if (liveSession === handle) {
      liveSession = null;
    }
  });
  return handle;
}

/**
 * WS ticket first (covers desktop and remote targets where the upgrade cannot
 * carry a cookie or bearer header), same-origin cookie as fallback.
 */
async function resolveDictationSocketUrl(): Promise<string> {
  const url = new URL(readPrimaryEnvironmentTarget().target.wsBaseUrl);
  url.pathname = "/api/dictation/stream";
  try {
    const response = await fetch(resolvePrimaryEnvironmentHttpUrl("/api/auth/websocket-ticket"), {
      method: "POST",
      credentials: "include",
    });
    if (response.ok) {
      const body = (await response.json()) as { ticket?: string };
      if (typeof body.ticket === "string" && body.ticket.length > 0) {
        url.searchParams.set("wsTicket", body.ticket);
      }
    }
  } catch {
    // Same-origin cookie auth on the upgrade remains as the fallback.
  }
  return url.toString();
}

function dbfs(amplitude: number): number {
  return amplitude > 0 ? 20 * Math.log10(amplitude) : Number.NEGATIVE_INFINITY;
}

/**
 * Streaming linear-interpolation resampler. Quality is ample for speech into a
 * 16 kHz recognizer; the alternative — forcing the AudioContext itself to
 * 16 kHz — renders silence from microphone sources in Chrome.
 */
export class LinearResampler {
  private previous = 0;
  private hasPrevious = false;
  /** Fractional read position relative to the previous sample. */
  private position = 0;
  private readonly ratio: number;

  constructor(sourceRate: number, targetRate: number) {
    this.ratio = sourceRate / targetRate;
  }

  push(samples: Float32Array): Float32Array {
    if (this.ratio === 1) {
      return samples;
    }
    if (samples.length === 0) {
      return samples;
    }
    const output: number[] = [];
    // Interpolation window: [previous, samples[0..]] — position is measured
    // with previous at index 0.
    const get = (index: number): number =>
      index === 0 && this.hasPrevious
        ? this.previous
        : samples[index - (this.hasPrevious ? 1 : 0)]!;
    const available = samples.length + (this.hasPrevious ? 1 : 0);
    while (this.position + 1 < available) {
      const base = Math.floor(this.position);
      const fraction = this.position - base;
      output.push(get(base) * (1 - fraction) + get(base + 1) * fraction);
      this.position += this.ratio;
    }
    this.position -= available - 1;
    this.previous = samples[samples.length - 1]!;
    this.hasPrevious = true;
    return Float32Array.from(output);
  }
}

/** Re-chunks arbitrary-length sample runs into fixed-size frames. */
export class FixedFramer {
  private buffer: Float32Array;
  private filled = 0;

  constructor(private readonly frameSamples: number) {
    this.buffer = new Float32Array(frameSamples);
  }

  push(samples: Float32Array): Float32Array[] {
    const frames: Float32Array[] = [];
    let offset = 0;
    while (offset < samples.length) {
      const take = Math.min(samples.length - offset, this.frameSamples - this.filled);
      this.buffer.set(samples.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;
      if (this.filled === this.frameSamples) {
        frames.push(this.buffer.slice());
        this.filled = 0;
      }
    }
    return frames;
  }

  /** Remaining partial frame zero-padded to full size, or null when empty. */
  flush(): Float32Array | null {
    if (this.filled === 0) {
      return null;
    }
    const frame = new Float32Array(this.frameSamples);
    frame.set(this.buffer.subarray(0, this.filled));
    this.filled = 0;
    return frame;
  }
}
