import { describe, expect, it } from "vite-plus/test";

import {
  createTypingSpeedMeter,
  isTypingKeystroke,
  TYPING_STREAK_STOPS,
  typingStreakHeat,
} from "./ComposerTypingStreak.logic";

const keystroke = {
  key: "a",
  repeat: false,
  isComposing: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
};

function wpmAt(intervalMs: number, count: number) {
  const meter = createTypingSpeedMeter();
  let wpm = 0;
  for (let index = 0; index < count; index += 1) wpm = meter.record(index * intervalMs);
  return wpm;
}

describe("isTypingKeystroke", () => {
  it("counts printable characters, including Option characters", () => {
    expect(isTypingKeystroke(keystroke)).toBe(true);
    expect(isTypingKeystroke({ ...keystroke, key: " " })).toBe(true);
    expect(isTypingKeystroke({ ...keystroke, key: "å", altKey: true })).toBe(true);
    expect(isTypingKeystroke({ ...keystroke, key: "😀" })).toBe(true);
  });

  it("ignores paste chords, held keys, IME composition, and named keys", () => {
    expect(isTypingKeystroke({ ...keystroke, key: "v", metaKey: true })).toBe(false);
    expect(isTypingKeystroke({ ...keystroke, key: "v", ctrlKey: true })).toBe(false);
    expect(isTypingKeystroke({ ...keystroke, repeat: true })).toBe(false);
    expect(isTypingKeystroke({ ...keystroke, isComposing: true })).toBe(false);
    expect(isTypingKeystroke({ ...keystroke, key: "Backspace" })).toBe(false);
    expect(isTypingKeystroke({ ...keystroke, key: "Enter" })).toBe(false);
  });
});

describe("createTypingSpeedMeter", () => {
  it("reports sustained pace in words per minute", () => {
    expect(wpmAt(100, 30)).toBe(120);
    expect(wpmAt(250, 30)).toBe(48);
  });

  it("needs fast typing to last before the glow starts and the fire colours follow", () => {
    // 150 WPM is a keystroke every 80ms.
    expect(typingStreakHeat(wpmAt(80, 12)).intensity).toBe(0);
    expect(typingStreakHeat(wpmAt(80, 20)).intensity).toBeGreaterThan(0);
    expect(typingStreakHeat(wpmAt(80, 20)).fire).toBe(0);
    expect(typingStreakHeat(wpmAt(80, 37)).fire).toBeGreaterThan(0);
  });

  it("needs a sustained burst rather than a couple of quick keys", () => {
    expect(typingStreakHeat(wpmAt(60, 3)).intensity).toBe(0);
  });

  it("cools down once old keystrokes leave the window", () => {
    const meter = createTypingSpeedMeter();
    for (let index = 0; index < 20; index += 1) meter.record(index * 80);
    expect(meter.record(20 * 80 + 3000)).toBe(4);
  });
});

describe("typingStreakHeat", () => {
  it("stays cold at a relaxed pace and warms to a full theme glow by 120 WPM", () => {
    expect(typingStreakHeat(60).intensity).toBe(0);
    const warming = typingStreakHeat(90);
    expect(warming.intensity).toBeGreaterThan(0);
    expect(warming.intensity).toBeLessThan(1);
    expect(typingStreakHeat(120)).toMatchObject({ intensity: 1, fire: 0, from: 0, blend: 0 });
  });

  it("turns to fire above 120 WPM, from orange through yellow and white to blue", () => {
    const colorAt = (wpm: number) => {
      const heat = typingStreakHeat(wpm);
      return TYPING_STREAK_STOPS[heat.blend > 0.5 ? heat.to : heat.from]?.color;
    };
    expect(colorAt(132)).toBe("#ff7a1a");
    expect(colorAt(146)).toBe("#ffc93c");
    expect(colorAt(160)).toBe("#fff3d6");
    expect(colorAt(200)).toBe("#4aa8ff");
    expect(typingStreakHeat(153)).toMatchObject({ from: 2, to: 3, blend: 0.5 });
  });

  it("measures fire from 120 WPM up to the hottest colour", () => {
    expect(typingStreakHeat(120).fire).toBe(0);
    expect(typingStreakHeat(147.5).fire).toBe(0.5);
    expect(typingStreakHeat(240).fire).toBe(1);
  });
});
