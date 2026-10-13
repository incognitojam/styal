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
    expect(typingStreakHeat(wpmAt(80, 24)).intensity).toBeGreaterThan(0);
    expect(typingStreakHeat(wpmAt(80, 24)).fire).toBe(0);
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
  it("stays cold at a relaxed pace and warms to a full theme glow by 140 WPM", () => {
    expect(typingStreakHeat(80).intensity).toBe(0);
    const warming = typingStreakHeat(110);
    expect(warming.intensity).toBeGreaterThan(0);
    expect(warming.intensity).toBeLessThan(1);
    expect(typingStreakHeat(140)).toMatchObject({ intensity: 1, fire: 0, from: 0, blend: 0 });
  });

  it("turns to fire above 140 WPM, then grows the fire as the pace rises", () => {
    const stopAt = (wpm: number) => {
      const heat = typingStreakHeat(wpm);
      return TYPING_STREAK_STOPS[heat.blend > 0.5 ? heat.to : heat.from];
    };
    expect(stopAt(140)?.fire).toBe(false);
    expect(stopAt(155)?.fire).toBe(true);
    expect(stopAt(170)!.blur).toBeGreaterThan(stopAt(155)!.blur);
    expect(stopAt(220)).toBe(TYPING_STREAK_STOPS[TYPING_STREAK_STOPS.length - 1]);
    expect(typingStreakHeat(147.5)).toMatchObject({ from: 0, to: 1, blend: 0.5 });
  });

  it("measures fire growth from 140 WPM up to the largest fire", () => {
    expect(typingStreakHeat(140).fire).toBe(0);
    expect(typingStreakHeat(162.5).fire).toBe(0.5);
    expect(typingStreakHeat(260).fire).toBe(1);
  });
});
