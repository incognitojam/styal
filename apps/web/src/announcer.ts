import {
  PULL_REQUEST_ANNOUNCEMENT_KINDS,
  pullRequestAnnouncementText,
  type PullRequestAnnouncement,
} from "@t3tools/client-runtime/pull-request-announcements";

import openingUrl from "./assets/notification-departures.mp3";
import closingUrl from "./assets/announcer/close.mp3";
import { loadNotificationBuffer, runningNotificationAudio } from "./threadNotifications";

const phraseUrls = import.meta.glob<string>("./assets/announcer/phrases/*.mp3", {
  eager: true,
  query: "?url",
  import: "default",
});

function phraseUrl(name: string) {
  const url = phraseUrls[`./assets/announcer/phrases/${name}.mp3`];
  if (!url) throw new Error(`Missing announcer phrase ${name}`);
  return url;
}

interface PlaybackRequest extends PullRequestAnnouncement {
  readonly text: string;
  readonly urls: ReadonlyArray<string>;
  readonly live: boolean;
}

/** One line on the announcement board, from the moment it is queued until its batch ends. */
export interface AnnouncementLine {
  readonly key: string;
  readonly text: string;
  readonly status: "spoken" | "speaking" | "queued";
}

interface PlaybackState {
  readonly playing: boolean;
  readonly error: string | null;
  readonly lines: ReadonlyArray<AnnouncementLine>;
}

function requestFor(announcement: PullRequestAnnouncement, live: boolean): PlaybackRequest {
  const { number, kind } = announcement;
  return {
    ...announcement,
    text: pullRequestAnnouncementText(number, kind),
    urls: [
      phraseUrl(kind === "cancelled" ? "cancelled-prefix" : "prefix"),
      ...String(number)
        .split("")
        .map((digit) => phraseUrl(`digit-${digit}`)),
      phraseUrl(kind),
    ],
    live,
  };
}

/** One opening and closing chime around each drained batch, shared by live events and previews. */
function createAnnouncerPlayer(onChange: (state: PlaybackState) => void) {
  let run: AbortController | undefined;
  let active: { request: PlaybackRequest; controller: AbortController } | undefined;
  let previews = 0;
  // Lines already spoken in the current batch stay listed until its closing chime ends.
  let spoken: PlaybackRequest[] = [];
  const pending = new Map<string, PlaybackRequest>();

  const line = (request: PlaybackRequest, status: AnnouncementLine["status"]) => ({
    key: request.key,
    text: request.text,
    status,
  });
  const publish = (error: string | null = null) =>
    onChange({
      playing: run !== undefined,
      error,
      lines: run
        ? [
            ...spoken.map((request) => line(request, "spoken")),
            ...(active ? [line(active.request, "speaking")] : []),
            ...[...pending.values()].map((request) => line(request, "queued")),
          ]
        : [],
    });

  async function prepare(audio: AudioContext, request: PlaybackRequest) {
    const parts = await Promise.all(request.urls.map((url) => loadNotificationBuffer(audio, url)));
    // Overlap only the 180 ms echo tails so separately recorded words do not add pauses.
    const overlap = Math.round(audio.sampleRate * 0.18);
    const length =
      parts.reduce((total, part) => total + part.length, 0) - overlap * (parts.length - 1);
    const sentence = audio.createBuffer(1, length, audio.sampleRate);
    const data = sentence.getChannelData(0);
    let offset = 0;
    for (const part of parts) {
      const samples = part.getChannelData(0);
      for (let i = 0; i < samples.length; i++) data[offset + i]! += samples[i]!;
      offset += part.length - overlap;
    }
    return sentence;
  }

  /** Resolves when the sound ends, or after `overlap` seconds while it keeps ringing. */
  async function play(
    audio: AudioContext,
    buffer: AudioBuffer,
    signal: AbortSignal,
    { volume = 1, overlap }: { volume?: number; overlap?: number } = {},
  ) {
    if (signal.aborted) return;
    const source = audio.createBufferSource();
    const gain = audio.createGain();
    source.buffer = buffer;
    gain.gain.value = volume;
    source.connect(gain);
    gain.connect(audio.destination);
    await new Promise<void>((resolve) => {
      const abort = () => source.stop();
      source.addEventListener(
        "ended",
        () => {
          signal.removeEventListener("abort", abort);
          source.disconnect();
          gain.disconnect();
          resolve();
        },
        { once: true },
      );
      signal.addEventListener("abort", abort, { once: true });
      source.start();
      if (overlap !== undefined) setTimeout(resolve, overlap * 1000);
    });
  }

  async function drain(audio: AudioContext, controller: AbortController) {
    const { signal } = controller;
    try {
      while (pending.size > 0 && !signal.aborted) {
        spoken = [];
        publish();
        // The voice starts as the chime's last note rings out, like a station PA.
        await play(audio, await loadNotificationBuffer(audio, openingUrl), signal, {
          overlap: 1.9,
        });
        while (pending.size > 0 && !signal.aborted) {
          const request = pending.values().next().value;
          if (!request) break;
          const sentence = await prepare(audio, request);
          if (signal.aborted) break;
          // Updates arriving during loading replace the pending announcement for this PR.
          if (pending.get(request.key) !== request) continue;
          pending.delete(request.key);
          const speech = new AbortController();
          const abort = () => speech.abort();
          signal.addEventListener("abort", abort, { once: true });
          active = { request, controller: speech };
          publish();
          await play(audio, sentence, speech.signal);
          signal.removeEventListener("abort", abort);
          // A line cut off because its PR changed is not left on the board.
          if (!speech.signal.aborted) spoken.push(request);
          if (active?.controller === speech) active = undefined;
          publish();
        }
        // A batch whose only lines were cut off ends without a closing chime.
        if (!signal.aborted && spoken.length > 0) {
          await play(audio, await loadNotificationBuffer(audio, closingUrl), signal, {
            volume: 10 ** (-2 / 20),
          });
        }
        // Anything queued during the closing chime begins a new batch.
      }
      if (run === controller) {
        run = undefined;
        spoken = [];
        publish();
      }
    } catch {
      if (run !== controller) return;
      pending.clear();
      run = undefined;
      active = undefined;
      spoken = [];
      publish("The announcement could not be played.");
    }
  }

  function stop() {
    pending.clear();
    run?.abort();
    run = undefined;
    active = undefined;
    spoken = [];
    publish();
  }

  function enqueue(request: PlaybackRequest) {
    const audio = runningNotificationAudio();
    if (!audio) return;
    // Map order is kept, so a newer update for a queued PR replaces its line in place.
    pending.set(request.key, request);
    if (run) {
      publish();
      return;
    }
    run = new AbortController();
    void drain(audio, run);
  }

  return {
    /** Plays a sample announcement, stepping through the vocabulary on each press. */
    preview() {
      const kind =
        PULL_REQUEST_ANNOUNCEMENT_KINDS[previews++ % PULL_REQUEST_ANNOUNCEMENT_KINDS.length]!;
      enqueue(requestFor({ key: "preview", number: 831, kind }, false));
    },
    announce(announcement: PullRequestAnnouncement) {
      enqueue(requestFor(announcement, true));
    },
    /** Drops queued or playing live announcements whose PR no longer has that status. */
    reconcile(current: ReadonlyMap<string, PullRequestAnnouncement["kind"] | null>) {
      let changed = false;
      for (const [key, request] of pending) {
        if (request.live && current.get(key) !== request.kind) changed = pending.delete(key);
      }
      if (active?.request.live && current.get(active.request.key) !== active.request.kind) {
        active.controller.abort();
      }
      // Nothing left to say in this batch: skip the chimes rather than announce nothing.
      if (run && spoken.length === 0 && !active && pending.size === 0) stop();
      else if (changed) publish();
    },
    stop,
  };
}

let playbackState: PlaybackState = { playing: false, error: null, lines: [] };
const listeners = new Set<() => void>();
export const announcerPlayer = createAnnouncerPlayer((state) => {
  playbackState = state;
  for (const listener of listeners) listener();
});
export const getAnnouncerPlayback = () => playbackState;
export function subscribeAnnouncerPlayback(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
