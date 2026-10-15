import {
  pullRequestAnnouncementText,
  type PullRequestAnnouncement,
  type PullRequestAnnouncementKind,
} from "@t3tools/client-runtime/pull-request-announcements";

import openingUrl from "./assets/notification-departures.mp3";
import closingUrl from "./assets/announcer/close.mp3";
import readyUrl from "./assets/announcer/ready.mp3";
import arrivedUrl from "./assets/announcer/arrived.mp3";
import ciFailureUrl from "./assets/announcer/ci-failure.mp3";
import mergeConflictUrl from "./assets/announcer/merge-conflict.mp3";
import stackDelayedUrl from "./assets/announcer/stack-delayed.mp3";
import changesRequestedUrl from "./assets/announcer/changes-requested.mp3";
import cancelledUrl from "./assets/announcer/cancelled.mp3";
import queueFailureUrl from "./assets/announcer/queue-failure.mp3";

// Claude's v4 preview recordings use fixed example PR numbers, not live PR state.
export const ANNOUNCER_SAMPLES = [
  {
    id: "ready",
    label: "Ready to depart, awaiting a member of train crew",
    text: "Pull request 8 3 1 is ready to depart. It is awaiting a member of train crew.",
    url: readyUrl,
  },
  { id: "arrived", label: "Has arrived", text: "Pull request 8 3 1 has arrived.", url: arrivedUrl },
  {
    id: "ci-failure",
    label: "Delayed due to a CI failure",
    text: "Pull request 8 3 1 is delayed. This is due to a CI failure.",
    url: ciFailureUrl,
  },
  {
    id: "merge-conflict",
    label: "Delayed due to a merge conflict",
    text: "Pull request 8 3 1 is delayed. This is due to a merge conflict.",
    url: mergeConflictUrl,
  },
  {
    id: "stack-delayed",
    label: "Delayed due to a slower running train ahead",
    text: "Pull request 8 3 2 is delayed. This is due to a slower running train ahead.",
    url: stackDelayedUrl,
  },
  {
    id: "changes-requested",
    label: "Held at a red signal",
    text: "Pull request 8 3 1 is being held at a red signal.",
    url: changesRequestedUrl,
  },
  {
    id: "cancelled",
    label: "Cancelled",
    text: "We are sorry to announce that pull request 8 3 1 has been cancelled.",
    url: cancelledUrl,
  },
  {
    id: "queue-failure",
    label: "Delayed due to a problem in the merge queue",
    text: "Pull request 8 3 1 is delayed. This is due to a problem in the merge queue.",
    url: queueFailureUrl,
  },
] as const;

type AnnouncerSample = (typeof ANNOUNCER_SAMPLES)[number];

const phraseUrls = import.meta.glob<string>("./assets/announcer/phrases/*.mp3", {
  eager: true,
  query: "?url",
  import: "default",
});

function phraseUrl(name: string) {
  const url = phraseUrls[`./assets/announcer/phrases/${name}.mp3`];
  if (!url) throw new Error(name);
  return url;
}

interface PlaybackRequest {
  readonly key: string;
  readonly kind: PullRequestAnnouncementKind;
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
  if (!Number.isSafeInteger(number) || number < 1) throw new RangeError("Pull request");
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
  let context: AudioContext | undefined;
  let run: AbortController | undefined;
  let lastRequest: PlaybackRequest | undefined;
  let active: { request: PlaybackRequest; controller: AbortController } | undefined;
  const pending = new Map<string, PlaybackRequest>();
  const buffers = new Map<string, Promise<AudioBuffer>>();

  const publish = (
    playing: boolean,
    current: PlaybackRequest | null = null,
    error: string | null = null,
  ) => onChange({ playing, current, error });

  function load(audio: AudioContext, url: string) {
    let buffer = buffers.get(url);
    if (!buffer) {
      buffer = fetch(url)
        .then((response) => {
          if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
          return response.arrayBuffer();
        })
        .then((data) => audio.decodeAudioData(data))
        .catch((error: unknown) => {
          buffers.delete(url);
          throw error;
        });
      buffers.set(url, buffer);
    }
    return buffer;
  }

  async function prepare(audio: AudioContext, request: PlaybackRequest) {
    const parts = await Promise.all(request.urls.map((url) => load(audio, url)));
    if (parts.length === 1) return parts[0]!;
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

  async function play(audio: AudioContext, buffer: AudioBuffer, signal: AbortSignal, volume = 1) {
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
    });
  }

  async function drain(audio: AudioContext, controller: AbortController) {
    const { signal } = controller;
    try {
      while (pending.size > 0 && !signal.aborted) {
        await play(audio, await load(audio, openingUrl), signal);
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
          await play(audio, await load(audio, closingUrl), signal, 10 ** (-2 / 20));
        }
        // Anything queued during the closing chime begins a new batch.
      }
      if (run === controller) {
        run = undefined;
        publish(false);
      }
    } catch (error) {
      if (run !== controller) return;
      pending.clear();
      run = undefined;
      active = undefined;
      publish(false, null, String(error));
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
    if (!context || context.state !== "running") return;
    pending.set(request.key, request);
    if (run) return;
    run = new AbortController();
    lastRequest = request;
    publish(true);
    void drain(context, run);
  }

  return {
    async unlock() {
      try {
        context ??= new AudioContext();
        await context.resume();
      } catch (error) {
        publish(false, null, String(error));
      }
    },
    preview(sample: AnnouncerSample, number: number | null) {
      enqueue(
        number === null
          ? {
              key: `preview:${sample.id}`,
              kind: sample.id,
              text: sample.text,
              urls: [sample.url],
              live: false,
            }
          : requestFor({ key: "preview", number, kind: sample.id }, false),
      );
    },
    announce(announcement: PullRequestAnnouncement) {
      enqueue(requestFor(announcement, true));
    },
    reconcile(current: ReadonlyMap<string, PullRequestAnnouncementKind | null>) {
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
    release() {
      stop();
      buffers.clear();
      void context?.close().catch(() => undefined);
      context = undefined;
    },
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
