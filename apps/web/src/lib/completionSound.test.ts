import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

class FakeAudioParam {
  value = 1;
  readonly setValueAtTime = vi.fn();
  readonly linearRampToValueAtTime = vi.fn();
  readonly exponentialRampToValueAtTime = vi.fn();
}

class FakeOscillator {
  type: OscillatorType = "sine";
  readonly frequency = new FakeAudioParam();
  readonly connect = vi.fn((destination: unknown) => destination);
  readonly addEventListener = vi.fn();
  readonly disconnect = vi.fn();
  readonly start = vi.fn();
  readonly stop = vi.fn();
}

class FakeGain {
  readonly gain = new FakeAudioParam();
  readonly connect = vi.fn((destination: unknown) => destination);
  readonly disconnect = vi.fn();
}

const audioContextInstances: FakeAudioContext[] = [];

class FakeAudioContext {
  currentTime = 10;
  readonly destination = {};
  state: AudioContextState = "running";
  readonly oscillators: FakeOscillator[] = [];
  readonly gains: FakeGain[] = [];
  readonly createOscillator = vi.fn(() => {
    const oscillator = new FakeOscillator();
    this.oscillators.push(oscillator);
    return oscillator;
  });
  readonly createGain = vi.fn(() => {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  });
  get oscillator(): FakeOscillator {
    const oscillator = this.oscillators[0];
    if (oscillator === undefined) {
      throw new Error("Expected an oscillator to be created.");
    }
    return oscillator;
  }
  get gain(): FakeGain {
    const gain = this.gains[0];
    if (gain === undefined) {
      throw new Error("Expected a gain node to be created.");
    }
    return gain;
  }
  readonly resume = vi.fn(async () => {
    this.state = "running";
  });

  constructor() {
    audioContextInstances.push(this);
  }
}

function stubSampleAudio() {
  const pause = vi.fn();
  const play = vi.fn().mockResolvedValue(undefined);
  const audioInstances: Array<{
    readonly url: string;
    preload: string;
    volume: number;
    currentTime: number;
  }> = [];
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
  audioContextInstances.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("playCompletionSound", () => {
  it("resumes a suspended audio context before scheduling Resolve", async () => {
    class SuspendedAudioContext extends FakeAudioContext {
      override state: AudioContextState = "suspended";
      override readonly resume = vi.fn(async () => {
        this.currentTime = 20;
        this.state = "running";
      });
    }
    vi.stubGlobal("AudioContext", SuspendedAudioContext);
    const { playCompletionSound } = await import("./completionSound");

    playCompletionSound("resolve");

    expect(audioContextInstances[0]?.oscillators).toHaveLength(0);
    await Promise.resolve();
    expect(audioContextInstances[0]?.resume).toHaveBeenCalledOnce();
    const audioContext = audioContextInstances[0]!;
    expect(audioContext.oscillator.start.mock.calls[0]?.[0]).toBeGreaterThan(
      audioContext.currentTime,
    );
  });

  it("schedules Resolve as a quiet B4 to C5 resolution", async () => {
    vi.stubGlobal("AudioContext", FakeAudioContext);
    const { playCompletionSound } = await import("./completionSound");

    playCompletionSound("resolve");

    const audioContext = audioContextInstances[0]!;
    expect(
      audioContext.oscillators.map((tone) => tone.frequency.setValueAtTime.mock.calls[0]?.[0]),
    ).toEqual([493.88, 523.25, 1046.5]);
    const start = audioContext.oscillator.start.mock.calls[0]![0];
    expect(audioContext.oscillators.map((tone) => tone.start.mock.calls[0]?.[0])).toEqual([
      start,
      expect.closeTo(start + 0.13),
      expect.closeTo(start + 0.13),
    ]);
    expect(
      audioContext.gains.map(({ gain }) => gain.linearRampToValueAtTime.mock.calls[0]?.[0]),
    ).toEqual([0.126, 0.177, 0.017]);

    for (const [index, { gain }] of audioContext.gains.entries()) {
      const oscillator = audioContext.oscillators[index]!;
      const [endGain, fadeEnd] = gain.linearRampToValueAtTime.mock.calls.at(-1)!;
      expect(gain.value).toBe(0);
      expect(gain.setValueAtTime).toHaveBeenCalledWith(0, oscillator.start.mock.calls[0]![0]);
      expect(endGain).toBe(0);
      expect(fadeEnd).toBeLessThan(oscillator.stop.mock.calls[0]![0]);
    }
  });

  it("preserves the first note's fade-in after a 25 ms setup delay", async () => {
    class DelayedAudioContext extends FakeAudioContext {
      constructor() {
        super();
        const createOscillator = this.createOscillator.getMockImplementation()!;
        this.createOscillator.mockImplementationOnce(() => {
          this.currentTime += 0.025;
          return createOscillator();
        });
      }
    }
    vi.stubGlobal("AudioContext", DelayedAudioContext);
    const { playCompletionSound } = await import("./completionSound");

    playCompletionSound("resolve");

    const audioContext = audioContextInstances[0]!;
    const start = audioContext.oscillator.start.mock.calls[0]![0];
    expect(start).toBeGreaterThan(audioContext.currentTime);
    expect(audioContext.gain.gain.setValueAtTime).toHaveBeenCalledWith(0, start);
  });

  it("does not fall back to a sample without Web Audio", async () => {
    const { audioInstances, pause, play } = stubSampleAudio();
    vi.stubGlobal("AudioContext", undefined);
    const { playCompletionSound } = await import("./completionSound");

    playCompletionSound("resolve");

    await Promise.resolve();
    expect(audioInstances).toEqual([]);
    expect(pause).not.toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
  });

  it("plays Avanti through the retained sample player", async () => {
    const { audioInstances, pause, play } = stubSampleAudio();
    const { playCompletionSound } = await import("./completionSound");

    playCompletionSound("avanti");

    expect(audioInstances).toEqual([
      expect.objectContaining({
        url: "/avanti.mp3",
        preload: "auto",
        volume: 0.28,
        currentTime: 0,
      }),
    ]);
    expect(pause).toHaveBeenCalledOnce();
    expect(play).toHaveBeenCalledOnce();
  });

  it("does nothing when completion sounds are disabled", async () => {
    const audioContext = vi.fn();
    const audio = vi.fn();
    vi.stubGlobal("AudioContext", audioContext);
    vi.stubGlobal("Audio", audio);
    const { playCompletionSound } = await import("./completionSound");

    playCompletionSound("none");

    expect(audioContext).not.toHaveBeenCalled();
    expect(audio).not.toHaveBeenCalled();
  });
});
