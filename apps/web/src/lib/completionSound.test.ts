import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { addToast } = vi.hoisted(() => ({ addToast: vi.fn() }));
vi.mock("../components/ui/toast", () => ({ toastManager: { add: addToast } }));

function stubSampleAudio() {
  const pause = vi.fn();
  const play = vi.fn().mockResolvedValue(undefined);
  const audioInstances: Array<{
    readonly url: string;
    preload: string;
    volume: number;
    currentTime: number;
    error: { code: number } | null;
    dispatchEvent: (event: Event) => boolean;
  }> = [];
  class FakeAudio extends EventTarget {
    error: { code: number } | null = null;
    preload = "";
    volume = 1;
    currentTime = 5;
    readonly pause = pause;
    readonly play = play;

    constructor(readonly url: string) {
      super();
      audioInstances.push(this);
    }
  }
  vi.stubGlobal("Audio", FakeAudio);
  return { audioInstances, pause, play };
}

beforeEach(() => {
  vi.resetModules();
  addToast.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("playCompletionSound", () => {
  it.each([
    { sound: "resolve", url: "/resolve.wav", volume: 1 },
    { sound: "avanti", url: "/avanti.mp3", volume: 0.28 },
    { sound: "windows-tada", url: "/_desktop/windows-tada.wav", volume: 1 },
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

  it("reports unavailable Windows Ta-da once without playing another sound", async () => {
    const { audioInstances, play } = stubSampleAudio();
    const { playCompletionSound } = await import("./completionSound");

    playCompletionSound("windows-tada");

    const sample = audioInstances[0]!;
    sample.error = { code: 4 };
    sample.dispatchEvent(new Event("error"));
    sample.dispatchEvent(new Event("error"));
    expect(addToast).toHaveBeenCalledOnce();
    expect(addToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Windows Ta-da is unavailable",
      }),
    );
    playCompletionSound("windows-tada");
    expect(play).toHaveBeenCalledTimes(2);
    expect(audioInstances).toHaveLength(2);
  });

  it.each(["AbortError", "NotAllowedError"])("ignores %s playback rejections", async (name) => {
    const { play } = stubSampleAudio();
    play.mockRejectedValueOnce(new DOMException("interrupted or blocked", name));
    const { playCompletionSound } = await import("./completionSound");
    playCompletionSound("windows-tada");
    playCompletionSound("windows-tada");
    await Promise.resolve();
    expect(addToast).not.toHaveBeenCalled();
  });

  it("does nothing when completion sounds are disabled", async () => {
    const { audioInstances, play } = stubSampleAudio();
    const { playCompletionSound } = await import("./completionSound");

    playCompletionSound("none");

    expect(audioInstances).toEqual([]);
    expect(play).not.toHaveBeenCalled();
  });
});
