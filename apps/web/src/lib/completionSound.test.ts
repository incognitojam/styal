import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

function stubSampleAudio() {
  const pause = vi.fn();
  const play = vi.fn().mockResolvedValue(undefined);
  const audioInstances: FakeAudio[] = [];
  class FakeAudio {
    preload = "";
    volume = 1;
    currentTime = 5;
    readonly pause = pause;
    readonly play = play;

    constructor(readonly url: string) {
      audioInstances.push(this);
    }
  }
  vi.stubGlobal("Audio", FakeAudio);
  return { audioInstances, pause, play };
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("playCompletionSound", () => {
  it.each([
    { sound: "resolve", url: "/resolve.wav", volume: 1 },
    { sound: "avanti", url: "/avanti.mp3", volume: 0.28 },
  ] as const)(
    "plays and reuses the $sound sample from the beginning",
    async ({ sound, url, volume }) => {
      const { audioInstances, pause, play } = stubSampleAudio();
      const { playCompletionSound } = await import("./completionSound");

      playCompletionSound(sound);

      expect(audioInstances).toEqual([
        expect.objectContaining({ url, preload: "auto", volume, currentTime: 0 }),
      ]);
      const audio = audioInstances[0]!;
      audio.currentTime = 0.2;

      playCompletionSound(sound);

      expect(audioInstances).toEqual([audio]);
      expect(audio.currentTime).toBe(0);
      expect(pause).toHaveBeenCalledTimes(2);
      expect(play).toHaveBeenCalledTimes(2);
    },
  );

  it("does nothing without browser audio support", async () => {
    vi.stubGlobal("Audio", undefined);
    const { playCompletionSound } = await import("./completionSound");

    expect(() => playCompletionSound("resolve")).not.toThrow();
  });

  it("does nothing when completion sounds are disabled", async () => {
    const { audioInstances, play } = stubSampleAudio();
    const { playCompletionSound } = await import("./completionSound");

    playCompletionSound("none");

    expect(audioInstances).toEqual([]);
    expect(play).not.toHaveBeenCalled();
  });
});
