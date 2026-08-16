import { describe, expect, it } from "vite-plus/test";

import { FixedFramer, LinearResampler } from "./dictationSession";

describe("LinearResampler", () => {
  it("passes samples through when rates match", () => {
    const resampler = new LinearResampler(16000, 16000);
    const input = Float32Array.from([0.1, 0.2, 0.3]);
    expect(resampler.push(input)).toBe(input);
  });

  it("halves the sample count for a 2:1 ratio across chunk boundaries", () => {
    const resampler = new LinearResampler(32000, 16000);
    let total = 0;
    for (let chunk = 0; chunk < 10; chunk += 1) {
      total += resampler.push(new Float32Array(1600)).length;
    }
    // 16000 input samples at 2:1 -> ~8000 out, minus edge effects.
    expect(total).toBeGreaterThan(7990);
    expect(total).toBeLessThanOrEqual(8000);
  });

  it("interpolates a constant signal without distortion", () => {
    const resampler = new LinearResampler(48000, 16000);
    const output = resampler.push(new Float32Array(4800).fill(0.5));
    expect(output.length).toBeGreaterThan(0);
    for (const sample of output) {
      expect(sample).toBeCloseTo(0.5, 6);
    }
  });

  it("produces a continuous ramp across chunk boundaries", () => {
    const resampler = new LinearResampler(48000, 16000);
    const first = Float32Array.from({ length: 480 }, (_, index) => index);
    const second = Float32Array.from({ length: 480 }, (_, index) => 480 + index);
    const output = [...resampler.push(first), ...resampler.push(second)];
    for (let index = 1; index < output.length; index += 1) {
      const step = output[index]! - output[index - 1]!;
      // A 3:1 ratio over a unit ramp advances 3 per output sample; a seam bug
      // would show up as a jump or repeat at the boundary.
      expect(step).toBeCloseTo(3, 5);
    }
  });
});

describe("FixedFramer", () => {
  it("re-chunks arbitrary runs into exact frames", () => {
    const framer = new FixedFramer(4);
    const frames = [
      ...framer.push(Float32Array.from([1, 2, 3])),
      ...framer.push(Float32Array.from([4, 5, 6, 7, 8, 9])),
      ...framer.push(Float32Array.from([10, 11, 12])),
    ];
    expect(frames.map((frame) => [...frame])).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
      [9, 10, 11, 12],
    ]);
  });

  it("flushes the trailing partial frame zero-padded", () => {
    const framer = new FixedFramer(4);
    expect(framer.push(Float32Array.from([1, 2, 3, 4, 5, 6]))).toHaveLength(1);
    expect([...(framer.flush() ?? [])]).toEqual([5, 6, 0, 0]);
    // Nothing pending after a flush.
    expect(framer.flush()).toBeNull();
  });
});
