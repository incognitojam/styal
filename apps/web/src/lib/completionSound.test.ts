import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

class FakeAudioParam {
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
  readonly currentTime = 10;
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
    }
    vi.stubGlobal("AudioContext", SuspendedAudioContext);
    const { playCompletionSound } = await import("./completionSound");

    playCompletionSound("resolve");

    await vi.waitFor(() => {
      expect(audioContextInstances[0]?.resume).toHaveBeenCalledOnce();
      expect(audioContextInstances[0]?.oscillator.start).toHaveBeenCalledWith(10);
    });
  });

  it("schedules Resolve as a quiet B4 to C5 resolution", async () => {
    vi.stubGlobal("AudioContext", FakeAudioContext);
    const { playCompletionSound } = await import("./completionSound");

    playCompletionSound("resolve");

    const [audioContext] = audioContextInstances;
    expect(audioContext).toBeDefined();
    if (audioContext === undefined) {
      throw new Error("Expected an audio context to be created.");
    }
    expect(audioContext.createOscillator).toHaveBeenCalledTimes(3);
    expect(audioContext.createGain).toHaveBeenCalledTimes(3);

    const [leadingTone, resolvedTone, harmonic] = audioContext.oscillators;
    expect(leadingTone?.frequency.setValueAtTime).toHaveBeenCalledWith(493.88, 10);
    expect(resolvedTone?.frequency.setValueAtTime).toHaveBeenCalledWith(523.25, 10.13);
    expect(harmonic?.frequency.setValueAtTime).toHaveBeenCalledWith(1046.5, 10.13);
    expect(leadingTone?.start).toHaveBeenCalledWith(10);
    expect(leadingTone?.stop.mock.calls[0]?.[0]).toBeCloseTo(10.19);
    expect(resolvedTone?.start.mock.calls[0]?.[0]).toBeCloseTo(10.13);
    expect(resolvedTone?.stop.mock.calls[0]?.[0]).toBeCloseTo(10.48);

    const [leadingGain, resolvedGain, harmonicGain] = audioContext.gains;
    expect(leadingGain?.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0.126, 10.018);
    expect(resolvedGain?.gain.linearRampToValueAtTime.mock.calls[0]?.[0]).toBe(0.177);
    expect(resolvedGain?.gain.linearRampToValueAtTime.mock.calls[0]?.[1]).toBeCloseTo(10.152);
    expect(harmonicGain?.gain.linearRampToValueAtTime.mock.calls[0]?.[0]).toBe(0.017);
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
