import { useEffect, useRef } from "react";

import {
  createTypingSpeedMeter,
  isTypingKeystroke,
  TYPING_STREAK_FIRE,
  TYPING_STREAK_FIRE_CORE,
  TYPING_STREAK_IDLE_MS,
  TYPING_STREAK_STOPS,
  typingStreakHeat,
  type TypingStreakHeat,
} from "./ComposerTypingStreak.logic";

const MAX_LIVE_SPARKS = 80;

let sparkLayer: HTMLDivElement | null = null;
let liveSparks = 0;

// Sparks fly past the composer's edges, so they live in one fixed layer on the body.
function getSparkLayer(): HTMLDivElement {
  if (sparkLayer?.isConnected) return sparkLayer;
  sparkLayer = document.createElement("div");
  sparkLayer.setAttribute("aria-hidden", "true");
  sparkLayer.style.cssText =
    "position:fixed;inset:0;z-index:60;overflow:hidden;pointer-events:none;contain:strict";
  document.body.append(sparkLayer);
  return sparkLayer;
}

function caretPoint(editor: HTMLElement): { x: number; y: number } | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return null;
  if (!editor.contains(selection.anchorNode)) return null;
  const range = selection.getRangeAt(0);
  const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
  if (rect.height === 0) return null;
  return { x: rect.left, y: rect.top + rect.height / 2 };
}

/** Theme-coloured below fire; fire sparks vary toward the core colour as the fire grows. */
function sparkColor({ fire, from, to, blend }: TypingStreakHeat): string {
  if (to === 0) return "var(--primary)";
  const core = Math.round(Math.random() * (30 + fire * 70));
  const flame = `color-mix(in oklab, ${TYPING_STREAK_FIRE_CORE} ${core}%, ${TYPING_STREAK_FIRE})`;
  // The theme glow is the only stop below fire, so blending from it is the turn to fire.
  if (from === 0)
    return `color-mix(in oklab, ${flame} ${Math.round(blend * 100)}%, var(--primary))`;
  return flame;
}

function glowShadow({ fire, blur, spread }: (typeof TYPING_STREAK_STOPS)[number]): string {
  if (!fire) {
    return `0 0 0 1px color-mix(in oklab, var(--primary) 55%, transparent), 0 0 ${blur}px ${spread}px color-mix(in oklab, var(--primary) 70%, transparent)`;
  }
  return `0 0 0 1px color-mix(in oklab, ${TYPING_STREAK_FIRE_CORE} 60%, transparent), 0 0 ${blur / 2}px ${spread}px color-mix(in oklab, ${TYPING_STREAK_FIRE_CORE} 45%, transparent), 0 0 ${blur}px ${spread}px color-mix(in oklab, ${TYPING_STREAK_FIRE} 70%, transparent)`;
}

/**
 * Animates transform and opacity only, so sparks stay on the compositor.
 * Past 140 WPM they turn to embers that grow bigger, more numerous, and rise higher
 * as the fire grows.
 */
function throwSparks(origin: { x: number; y: number }, count: number, heat: TypingStreakHeat) {
  const layer = getSparkLayer();
  const { intensity, fire } = heat;
  for (let index = 0; index < count && liveSparks < MAX_LIVE_SPARKS; index += 1) {
    const size = 2 + Math.random() * (2 + intensity * 2 + fire * 3);
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * (1 - fire * 0.4);
    const distance = 10 + Math.random() * (14 + intensity * 22 + fire * 34);
    const dx = Math.cos(angle) * distance;
    const dy = Math.sin(angle) * distance;
    const settle = 8 - fire * 22;
    const x = origin.x - size / 2;
    const y = origin.y - size / 2;
    const spark = document.createElement("div");
    spark.style.cssText = `position:absolute;left:0;top:0;width:${size}px;height:${size}px;border-radius:9999px;background:color-mix(in oklab, ${sparkColor(heat)} ${Math.round(60 + Math.random() * 40)}%, white)`;
    layer.append(spark);
    liveSparks += 1;
    const animation = spark.animate(
      [
        { transform: `translate(${x}px, ${y}px) scale(1)`, opacity: 1 },
        {
          transform: `translate(${x + dx * 0.8}px, ${y + dy * 0.8}px) scale(0.8)`,
          opacity: 0.9,
          offset: 0.55,
        },
        { transform: `translate(${x + dx}px, ${y + dy + settle}px) scale(0.2)`, opacity: 0 },
      ],
      {
        duration: 380 + Math.random() * 260 + fire * 280,
        easing: "cubic-bezier(0.2, 0.7, 0.3, 1)",
      },
    );
    const remove = () => {
      spark.remove();
      liveSparks -= 1;
    };
    animation.addEventListener("finish", remove);
    animation.addEventListener("cancel", remove);
  }
}

/**
 * Warms the composer's edge and throws sparks from the caret while the user
 * types quickly, turning to fire past 140 WPM and growing as the pace rises.
 * Render it inside the composer surface; it listens to keystrokes from
 * editors in its parent.
 */
export function ComposerTypingStreak({ enabled }: { enabled: boolean }) {
  const glowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const glow = glowRef.current;
    const surface = glow?.parentElement;
    if (!enabled || !glow || !surface) return;
    // One glow per stop, cross-faded by opacity: colour and size changes would repaint.
    const layers = Array.from(glow.children, (layer) => layer as HTMLElement);
    const opacities = layers.map(() => 0);
    const meter = createTypingSpeedMeter();
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let heat: TypingStreakHeat | null = null;
    let pendingSparks = 0;
    let frame: number | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let editor: HTMLElement | null = null;

    const setGlow = (next: TypingStreakHeat | null) => {
      heat = next;
      layers.forEach((layer, index) => {
        let target = 0;
        if (next && index === next.from) target += next.intensity * (1 - next.blend);
        if (next && index === next.to) target += next.intensity * next.blend;
        const current = opacities[index]!;
        if (Math.abs(target - current) < 0.03 && (target === 0) === (current === 0)) return;
        layer.style.transitionDuration = target > current ? "120ms" : "600ms";
        layer.style.opacity = String(target);
        opacities[index] = target;
      });
    };

    const flushSparks = () => {
      frame = null;
      const origin = editor ? caretPoint(editor) : null;
      if (origin && heat) throwSparks(origin, pendingSparks, heat);
      pendingSparks = 0;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isTypingKeystroke(event)) return;
      if (!(event.target instanceof HTMLElement) || !event.target.isContentEditable) return;
      if (reducedMotion.matches) return;
      editor = event.target;
      const next = typingStreakHeat(meter.record(event.timeStamp));
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimer = null;
        setGlow(null);
      }, TYPING_STREAK_IDLE_MS);
      setGlow(next.intensity > 0 ? next : null);
      if (next.intensity === 0) return;
      // The character lands after keydown; read the caret once it has moved.
      pendingSparks += 1 + Math.round(next.intensity * 2 + next.fire * 4);
      frame ??= requestAnimationFrame(flushSparks);
    };

    surface.addEventListener("keydown", onKeyDown);
    return () => {
      surface.removeEventListener("keydown", onKeyDown);
      if (idleTimer !== null) clearTimeout(idleTimer);
      if (frame !== null) cancelAnimationFrame(frame);
      setGlow(null);
    };
  }, [enabled]);

  if (!enabled) return null;
  return (
    <div
      ref={glowRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 rounded-[inherit]"
    >
      {TYPING_STREAK_STOPS.map((stop) => (
        <div
          key={stop.wpm}
          className="absolute inset-0 rounded-[inherit] opacity-0 transition-opacity ease-out"
          style={{ boxShadow: glowShadow(stop) }}
        />
      ))}
    </div>
  );
}
