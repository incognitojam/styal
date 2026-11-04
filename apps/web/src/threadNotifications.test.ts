import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const SOUND_SECONDS = 0.6;

const audio = {
  currentTime: 0,
  started: 0,
  contexts: [] as FakeAudioContext[],
  playing: [] as (() => void)[],
  failResume: false,
};
const gain = { gain: { value: 0 }, connect() {} };
const fetchSample = vi.fn();

class FakeAudioContext {
  state: AudioContextState = "running";
  destination = {};
  constructor() {
    audio.contexts.push(this);
  }
  get currentTime() {
    return audio.currentTime;
  }
  resume() {
    if (audio.failResume) return Promise.reject(new Error("Failed to start the audio device"));
    this.state = "running";
    return Promise.resolve();
  }
  suspend() {
    this.state = "suspended";
    return Promise.resolve();
  }
  close() {
    this.state = "closed";
    return Promise.resolve();
  }
  decodeAudioData() {
    return Promise.resolve({ duration: SOUND_SECONDS });
  }
  createBufferSource() {
    let onEnded = () => {};
    return {
      buffer: null,
      connect() {},
      addEventListener(_type: "ended", listener: () => void) {
        onEnded = listener;
      },
      start() {
        audio.started += 1;
        audio.playing.push(() => onEnded());
      },
    };
  }
  createGain() {
    return gain;
  }
}

async function loadUnlocked() {
  const notifications = await import("./threadNotifications");
  await notifications.unlockNotificationAudio();
  return notifications;
}

beforeEach(() => {
  vi.resetModules();
  audio.currentTime = 0;
  audio.started = 0;
  audio.contexts = [];
  audio.playing = [];
  audio.failResume = false;
  fetchSample.mockReset().mockResolvedValue({ arrayBuffer: async () => new ArrayBuffer(0) });
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("fetch", fetchSample);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it.each([
  { sound: "t3-completion", url: "/src/assets/notification-completion.mp3", volume: 1 },
  { sound: "t3-input", url: "/src/assets/notification-input.mp3", volume: 1 },
  { sound: "avanti", url: "/avanti.mp3", volume: 0.28 },
  { sound: "departures", url: "/src/assets/notification-departures.mp3", volume: 1 },
] as const)(
  "uses the selected $sound sample and normalized level",
  async ({ sound, url, volume }) => {
    const { playNotificationSound } = await loadUnlocked();
    await playNotificationSound("completion", () => true, sound);
    audio.currentTime = SOUND_SECONDS;
    await playNotificationSound("completion", () => true, sound);
    expect(fetchSample).toHaveBeenCalledExactlyOnceWith(url);
    expect(gain.gain.value).toBe(volume);
    expect(audio.started).toBe(2);
  },
);

it("suppresses playback before a gesture, for None, and when preferences change during decode", async () => {
  const { unlockNotificationAudio, playNotificationSound } = await import("./threadNotifications");
  await playNotificationSound("completion", () => true);
  expect(fetchSample).not.toHaveBeenCalled();
  await unlockNotificationAudio();
  await playNotificationSound("completion", () => true, "none");
  expect(fetchSample).not.toHaveBeenCalled();
  await playNotificationSound("completion", () => false);
  expect(audio.started).toBe(0);
});

it("toggles system notifications and sounds without changing the other", async () => {
  const { hasDesktopNotifications, hasNotificationSound, notificationModeFor } =
    await import("./threadNotifications");
  for (const desktop of [false, true]) {
    for (const sound of [false, true]) {
      const mode = notificationModeFor(desktop, sound);
      expect([hasDesktopNotifications(mode), hasNotificationSound(mode)]).toEqual([desktop, sound]);
    }
  }
});

describe("playNotificationSound", () => {
  it("plays one sound for threads that complete together", async () => {
    const { playNotificationSound } = await loadUnlocked();

    await Promise.all(
      Array.from({ length: 4 }, () => playNotificationSound("completion", () => true)),
    );

    expect(audio.started).toBe(1);
  });

  it("still plays an input alert over a completion sound", async () => {
    const { playNotificationSound } = await loadUnlocked();
    await playNotificationSound("completion", () => true);

    await playNotificationSound("input", () => true);

    expect(audio.started).toBe(2);
  });

  it("still plays an input alert over a completion that uses the same sample", async () => {
    const { playNotificationSound } = await loadUnlocked();
    await playNotificationSound("completion", () => true, "avanti");

    await playNotificationSound("input", () => true, "avanti");

    expect(audio.started).toBe(2);
  });

  it("leaves the slot free when a sound is turned off before it plays", async () => {
    const { playNotificationSound } = await loadUnlocked();
    await playNotificationSound("completion", () => false);

    await playNotificationSound("completion", () => true);

    expect(audio.started).toBe(1);
  });

  it("holds the output device only while a sound plays", async () => {
    const { playNotificationSound } = await loadUnlocked();
    const [context] = audio.contexts;
    expect(context?.state).toBe("suspended");

    await Promise.all([
      playNotificationSound("completion", () => true),
      playNotificationSound("input", () => true),
    ]);
    expect(context?.state).toBe("running");
    audio.playing[0]?.();
    expect(context?.state).toBe("running");
    audio.playing[1]?.();

    expect(context?.state).toBe("suspended");
  });

  it("replaces a context that can no longer reach an output device", async () => {
    const { playNotificationSound } = await loadUnlocked();
    audio.failResume = true;
    await playNotificationSound("completion", () => true);
    expect(audio.contexts[0]?.state).toBe("closed");

    audio.failResume = false;
    await playNotificationSound("completion", () => true);

    expect(audio.contexts).toHaveLength(2);
    expect(audio.started).toBe(1);
  });
});
