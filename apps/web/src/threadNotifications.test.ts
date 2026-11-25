import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const SOUND_SECONDS = 0.6;

const audio = { currentTime: 0, started: 0 };

class FakeAudioContext {
  state = "running";
  destination = {};
  get currentTime() {
    return audio.currentTime;
  }
  resume() {
    return Promise.resolve();
  }
  decodeAudioData() {
    return Promise.resolve({ duration: SOUND_SECONDS });
  }
  createGain() {
    return { gain: { value: 1 }, connect() {} };
  }
  createBufferSource() {
    return {
      buffer: null,
      connect() {},
      start() {
        audio.started += 1;
      },
    };
  }
}

async function loadUnlocked() {
  const notifications = await import("./threadNotifications");
  notifications.unlockNotificationAudio();
  return notifications;
}

beforeEach(() => {
  vi.resetModules();
  audio.currentTime = 0;
  audio.started = 0;
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(0) })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("playNotificationSound", () => {
  it("preloads both sounds on unlock and reuses them for playback", async () => {
    const { unlockNotificationAudio, playNotificationSound } = await loadUnlocked();
    expect(fetch).toHaveBeenCalledTimes(2);
    unlockNotificationAudio();
    await playNotificationSound("completion", () => true);
    await playNotificationSound("input", () => true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(audio.started).toBe(2);
  });

  it("retries failed preloads on an alert rather than every gesture", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("offline"));
    const { unlockNotificationAudio, playNotificationSound } = await loadUnlocked();
    await playNotificationSound("completion", () => true);
    expect(fetch).toHaveBeenCalledTimes(2);

    unlockNotificationAudio();
    expect(fetch).toHaveBeenCalledTimes(2);

    vi.mocked(fetch).mockResolvedValue(new Response(new ArrayBuffer(0)));
    await playNotificationSound("completion", () => true);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(audio.started).toBe(1);
  });

  it("plays one sound for threads that complete together", async () => {
    const { playNotificationSound } = await loadUnlocked();

    await Promise.all(
      Array.from({ length: 4 }, () => playNotificationSound("completion", () => true)),
    );

    expect(audio.started).toBe(1);
  });

  it("still plays an input alert over a completion sound", async () => {
    const { playNotificationSound } = await loadUnlocked();
    await playNotificationSound("completion", () => true, "avanti");

    await playNotificationSound("input", () => true, "avanti");

    expect(audio.started).toBe(2);
  });

  it("leaves the slot free when a sound is turned off before it plays", async () => {
    const { playNotificationSound, notificationSoundForEvent } = await loadUnlocked();
    const settings = {
      completionSound: "none",
      inputSound: "avanti",
      approvalSound: "departures",
    } as const;
    expect(notificationSoundForEvent(settings, "completion")).toBe("none");
    expect(notificationSoundForEvent(settings, "input")).toBe("avanti");
    expect(notificationSoundForEvent(settings, "approval")).toBe("departures");
    await playNotificationSound("completion", () => true, "none");
    expect(audio.started).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(2);
    await playNotificationSound("completion", () => false);

    await playNotificationSound("completion", () => true);

    expect(audio.started).toBe(1);
    await playNotificationSound("input", () => true, "avanti");
    await playNotificationSound("input", () => true, "departures");
    expect(audio.started).toBe(3);
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});
