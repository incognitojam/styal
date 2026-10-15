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

interface PlaybackState {
  readonly playing: boolean;
  readonly error: string | null;
  readonly current: PlaybackRequest | null;
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
  let lastRequest: PlaybackRequest | undefined;
  let active: { request: PlaybackRequest; controller: AbortController } | undefined;
  let previews = 0;
  const pending = new Map<string, PlaybackRequest>();

  const publish = (
    playing: boolean,
    current: PlaybackRequest | null = null,
    error: string | null = null,
  ) => onChange({ playing, current, error });

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
          lastRequest = request;
          publish(true, request);
          await play(audio, sentence, speech.signal);
          signal.removeEventListener("abort", abort);
          if (active?.controller === speech) active = undefined;
        }
        if (!signal.aborted) {
          publish(true);
          await play(audio, await loadNotificationBuffer(audio, closingUrl), signal, {
            volume: 10 ** (-2 / 20),
          });
        }
        // Anything queued during the closing chime begins a new batch.
      }
      if (run === controller) {
        run = undefined;
        publish(false);
      }
    } catch {
      if (run !== controller) return;
      pending.clear();
      run = undefined;
      active = undefined;
      publish(false, null, "The announcement could not be played.");
    }
  }

  function stop() {
    pending.clear();
    run?.abort();
    run = undefined;
    active = undefined;
    lastRequest = undefined;
    publish(false);
  }

  function enqueue(request: PlaybackRequest) {
    const audio = runningNotificationAudio();
    if (!audio) return;
    pending.set(request.key, request);
    if (run) return;
    run = new AbortController();
    lastRequest = request;
    publish(true);
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
      for (const [key, request] of pending) {
        if (request.live && current.get(key) !== request.kind) pending.delete(key);
      }
      if (active?.request.live && current.get(active.request.key) !== active.request.kind) {
        active.controller.abort();
      }
      if (
        run &&
        pending.size === 0 &&
        lastRequest?.live &&
        current.get(lastRequest.key) !== lastRequest.kind
      ) {
        stop();
      }
    },
    stop,
  };
}

let playbackState: PlaybackState = { playing: false, current: null, error: null };
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
