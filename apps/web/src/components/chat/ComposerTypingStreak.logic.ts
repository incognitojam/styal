/**
 * Pace is averaged over this window and counts from zero while it fills, so
 * the glow needs a second or two of fast typing to start, and a short burst
 * of quick words cannot sweep through the fire colours.
 */
const WINDOW_MS = 3000;
/** A pause this long ends the streak. */
export const TYPING_STREAK_IDLE_MS = 350;
// Speeds are words per minute, counting five characters as a word.
const GLOW_START_WPM = 65;
const GLOW_FULL_WPM = 120;

/**
 * Glow colours from the calm theme glow to the hottest fire, each fully
 * shown at its speed and blended between neighbours.
 */
export const TYPING_STREAK_STOPS = [
  { wpm: 120, color: "var(--primary)" },
  { wpm: 132, color: "#ff7a1a" },
  { wpm: 146, color: "#ffc93c" },
  { wpm: 160, color: "#fff3d6" },
  { wpm: 175, color: "#4aa8ff" },
] as const;

export interface TypingStreakHeat {
  /** 0–1 glow strength, full from 120 WPM. */
  intensity: number;
  /** 0–1 progress through the fire colours above 120 WPM. */
  fire: number;
  /** Stop indexes to blend between, and how far toward `to`. */
  from: number;
  to: number;
  blend: number;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/**
 * Whether a keydown is the user typing a character. Paste, shortcuts, held
 * keys, and IME composition never warm the composer.
 */
export function isTypingKeystroke(event: {
  key: string;
  repeat: boolean;
  isComposing: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}): boolean {
  // Option produces characters on macOS, so only Ctrl/Cmd chords are shortcuts.
  if (event.repeat || event.isComposing || event.metaKey || event.ctrlKey) return false;
  return [...event.key].length === 1;
}

/** Tracks recent keystrokes and reports their pace in words per minute. */
export function createTypingSpeedMeter() {
  let strokes: number[] = [];
  return {
    record(now: number): number {
      strokes = strokes.filter((at) => now - at < WINDOW_MS && now - at >= 0);
      strokes.push(now);
      return (strokes.length / (WINDOW_MS / 1000)) * 12;
    },
  };
}

export function typingStreakHeat(wpm: number): TypingStreakHeat {
  const first = TYPING_STREAK_STOPS[0];
  const hottest = TYPING_STREAK_STOPS[TYPING_STREAK_STOPS.length - 1]!;
  const last = TYPING_STREAK_STOPS.length - 1;
  const intensity = clamp01((wpm - GLOW_START_WPM) / (GLOW_FULL_WPM - GLOW_START_WPM));
  const fire = clamp01((wpm - first.wpm) / (hottest.wpm - first.wpm));
  const to = TYPING_STREAK_STOPS.findIndex((stop) => wpm < stop.wpm);
  if (to === 0) return { intensity, fire, from: 0, to: 0, blend: 0 };
  if (to === -1) return { intensity, fire, from: last, to: last, blend: 0 };
  const from = to - 1;
  const lower = TYPING_STREAK_STOPS[from]!.wpm;
  const blend = (wpm - lower) / (TYPING_STREAK_STOPS[to]!.wpm - lower);
  return { intensity, fire, from, to, blend };
}
