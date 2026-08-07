import type { CompletionSound } from "@t3tools/contracts";

const AVANTI_SAMPLE_URL = "/avanti.mp3";
const AVANTI_SAMPLE_VOLUME = 0.7;
const CHIME_FREQUENCY_HZ = 523.252;
const CHIME_PEAK_GAIN = 0.2;
const CHIME_END_GAIN = 0.00016;
const CHIME_HOLD_SECONDS = 0.06;
const CHIME_DECAY_SECONDS = 1.36;
const CHIME_STOP_SECONDS = 1.37;

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

function scheduleCompletionChime(audioContext: AudioContext): void {
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  const now = audioContext.currentTime;

  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(CHIME_FREQUENCY_HZ, now);
  gain.gain.setValueAtTime(CHIME_PEAK_GAIN, now);
  gain.gain.setValueAtTime(CHIME_PEAK_GAIN, now + CHIME_HOLD_SECONDS);
  gain.gain.exponentialRampToValueAtTime(CHIME_END_GAIN, now + CHIME_DECAY_SECONDS);

  oscillator.connect(gain).connect(audioContext.destination);
  oscillator.addEventListener(
    "ended",
    () => {
      oscillator.disconnect();
      gain.disconnect();
    },
    { once: true },
  );
  oscillator.start(now);
  oscillator.stop(now + CHIME_STOP_SECONDS);
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

    scheduleCompletionChime(audioContext);
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
