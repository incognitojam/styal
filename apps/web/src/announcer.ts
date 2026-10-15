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

/** Manual playback only: one opening and closing chime around each drained batch. */
export function createAnnouncerPlayer(
  onChange: (state: { playing: boolean; error: string | null }) => void,
) {
  let context: AudioContext | undefined;
  let run: AbortController | undefined;
  let disposed = false;
  const pending = new Map<AnnouncerSample["id"], AnnouncerSample>();
  const buffers = new Map<string, Promise<AudioBuffer>>();

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

  async function play(audio: AudioContext, url: string, signal: AbortSignal, volume = 1) {
    const buffer = await load(audio, url);
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

  async function drain(audio: AudioContext, controller: AbortController, unlocked: Promise<void>) {
    const { signal } = controller;
    try {
      await unlocked;
      while (pending.size > 0 && !signal.aborted) {
        await play(audio, openingUrl, signal);
        while (pending.size > 0 && !signal.aborted) {
          const sample = pending.values().next().value;
          if (!sample) break;
          pending.delete(sample.id);
          await play(audio, sample.url, signal);
        }
        if (!signal.aborted) await play(audio, closingUrl, signal, 10 ** (-2 / 20));
        // Anything queued during the closing chime begins a new batch.
      }
      if (run === controller) {
        run = undefined;
        onChange({ playing: false, error: null });
      }
    } catch (error) {
      if (run !== controller) return;
      pending.clear();
      run = undefined;
      onChange({ playing: false, error: String(error) });
    }
  }

  function stop() {
    pending.clear();
    run?.abort();
    run = undefined;
    if (!disposed) onChange({ playing: false, error: null });
  }

  return {
    enqueue(sample: AnnouncerSample) {
      if (disposed) return;
      try {
        context ??= new AudioContext();
        // Resume synchronously in the Preview gesture before loading any assets.
        const unlocked = context.resume();
        pending.set(sample.id, sample);
        if (run) {
          void unlocked.catch(() => undefined);
          return;
        }
        run = new AbortController();
        onChange({ playing: true, error: null });
        void drain(context, run, unlocked);
      } catch (error) {
        pending.clear();
        onChange({ playing: false, error: String(error) });
      }
    },
    stop,
    dispose() {
      disposed = true;
      stop();
      buffers.clear();
      void context?.close().catch(() => undefined);
    },
  };
}
