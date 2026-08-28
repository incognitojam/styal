import type { CompletionSound } from "@t3tools/contracts";

const AVANTI_SAMPLE_URL = "/avanti.mp3";
const AVANTI_SAMPLE_VOLUME = 0.28;
const RESOLVE_END_GAIN = 0.0001;
const RESOLVE_TONES = [
  {
    frequencyHz: 493.88,
    offsetSeconds: 0,
    durationSeconds: 0.17,
    attackSeconds: 0.018,
    releaseSeconds: 0.06,
    peakGain: 0.126,
    sustainRatio: 0.2,
  },
  {
    frequencyHz: 523.25,
    offsetSeconds: 0.13,
    durationSeconds: 0.33,
    attackSeconds: 0.022,
    releaseSeconds: 0.12,
    peakGain: 0.177,
    sustainRatio: 0.22,
  },
  {
    frequencyHz: 1046.5,
    offsetSeconds: 0.13,
    durationSeconds: 0.22,
    attackSeconds: 0.024,
    releaseSeconds: 0.09,
    peakGain: 0.017,
    sustainRatio: 0.12,
  },
] as const;

let completionAudioContext: AudioContext | null = null;
const sampleAudioByUrl = new Map<string, HTMLAudioElement>();

function getCompletionAudioContext(): AudioContext | null {
  if (typeof AudioContext === "undefined") {
    return null;
  }

  if (completionAudioContext?.state === "closed") {
    completionAudioContext = null;
  }
  completionAudioContext ??= new AudioContext();
  return completionAudioContext;
}

function scheduleCompletionResolve(audioContext: AudioContext): void {
  const now = audioContext.currentTime;

  for (const tone of RESOLVE_TONES) {
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    const start = now + tone.offsetSeconds;
    const end = start + tone.durationSeconds;
    const releaseStart = end - tone.releaseSeconds;

    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(tone.frequencyHz, start);
    gain.gain.setValueAtTime(RESOLVE_END_GAIN, start);
    gain.gain.linearRampToValueAtTime(tone.peakGain, start + tone.attackSeconds);
    gain.gain.exponentialRampToValueAtTime(tone.peakGain * tone.sustainRatio, releaseStart);
    gain.gain.linearRampToValueAtTime(RESOLVE_END_GAIN, end);

    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.addEventListener(
      "ended",
      () => {
        oscillator.disconnect();
        gain.disconnect();
      },
      { once: true },
    );
    oscillator.start(start);
    oscillator.stop(end + 0.02);
  }
}

async function playProceduralCompletionSound(): Promise<void> {
  try {
    const audioContext = getCompletionAudioContext();
    if (audioContext === null) {
      return;
    }
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }
    if (audioContext.state !== "running") {
      return;
    }

    scheduleCompletionResolve(audioContext);
  } catch {
    // Browser audio support and autoplay policy vary by client.
  }
}

export function playSoundSample(url: string, volume: number): void {
  if (typeof Audio === "undefined") {
    return;
  }

  let audio = sampleAudioByUrl.get(url);
  if (audio === undefined) {
    audio = new Audio(url);
    audio.preload = "auto";
    sampleAudioByUrl.set(url, audio);
  }

  audio.volume = Math.max(0, Math.min(1, volume));
  audio.pause();
  audio.currentTime = 0;
  void audio.play().catch(() => {
    // Browser autoplay policy can block this until the user interacts with the page.
  });
}

export function playCompletionSound(sound: CompletionSound): void {
  if (sound === "none") {
    return;
  }
  if (sound === "avanti") {
    playSoundSample(AVANTI_SAMPLE_URL, AVANTI_SAMPLE_VOLUME);
    return;
  }
  void playProceduralCompletionSound();
}
