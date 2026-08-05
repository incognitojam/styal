import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

class FakeAudioParam {
  readonly setValueAtTime = vi.fn();
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
  readonly oscillator = new FakeOscillator();
  readonly gain = new FakeGain();
  readonly createOscillator = vi.fn(() => this.oscillator);
  readonly createGain = vi.fn(() => this.gain);
  readonly resume = vi.fn(async () => {
    this.state = "running";
  });

  constructor() {
    audioContextInstances.push(this);
  }
}

beforeEach(() => {
  vi.resetModules();
  audioContextInstances.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("playCompletionSound", () => {
  it("schedules the procedural C5 chime with an app-level exponential tail", async () => {
    vi.stubGlobal("AudioContext", FakeAudioContext);
    const { playCompletionSound } = await import("./completionSound");

    playCompletionSound("chime");

    const [audioContext] = audioContextInstances;
    expect(audioContext).toBeDefined();
    if (audioContext === undefined) {
      throw new Error("Expected an audio context to be created.");
    }
    expect(audioContext.oscillator.type).toBe("sine");
    expect(audioContext.oscillator.frequency.setValueAtTime).toHaveBeenCalledWith(523.252, 10);
    expect(audioContext.gain.gain.setValueAtTime).toHaveBeenNthCalledWith(1, 0.2, 10);
    expect(audioContext.gain.gain.setValueAtTime).toHaveBeenNthCalledWith(2, 0.2, 10.06);
    expect(audioContext.gain.gain.exponentialRampToValueAtTime).toHaveBeenCalledWith(
      0.00016,
      11.36,
    );
    expect(audioContext.oscillator.connect).toHaveBeenCalledWith(audioContext.gain);
    expect(audioContext.gain.connect).toHaveBeenCalledWith(audioContext.destination);
    expect(audioContext.oscillator.start).toHaveBeenCalledWith(10);
    expect(audioContext.oscillator.stop.mock.calls[0]?.[0]).toBeCloseTo(11.37);
  });

  it("resumes a suspended audio context before scheduling the chime", async () => {
    class SuspendedAudioContext extends FakeAudioContext {
      override state: AudioContextState = "suspended";
    }
    vi.stubGlobal("AudioContext", SuspendedAudioContext);
    const { playCompletionSound } = await import("./completionSound");

    playCompletionSound("chime");

    await vi.waitFor(() => {
      expect(audioContextInstances[0]?.resume).toHaveBeenCalledOnce();
      expect(audioContextInstances[0]?.oscillator.start).toHaveBeenCalledWith(10);
    });
  });

  it("does nothing when Web Audio is unavailable", async () => {
    const audio = vi.fn();
    vi.stubGlobal("AudioContext", undefined);
    vi.stubGlobal("Audio", audio);
    const { playCompletionSound } = await import("./completionSound");

    playCompletionSound("chime");

    await Promise.resolve();
    expect(audio).not.toHaveBeenCalled();
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
