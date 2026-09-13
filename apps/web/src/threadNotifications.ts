import type { ClientSettings, CompletionSound } from "@t3tools/contracts/settings";

import { completionSoundSample } from "./lib/completionSound";

type NotificationMode = ClientSettings["notificationMode"];
export const NOTIFICATION_MODE_LABELS = {
  off: "Off",
  notifications: "Notifications only",
  sound: "Sound only",
  "notifications-and-sound": "Notifications with sound",
} satisfies Record<NotificationMode, string>;

export function hasNotificationSound(mode: NotificationMode) {
  return mode === "sound" || mode === "notifications-and-sound";
}

export function hasDesktopNotifications(mode: NotificationMode) {
  return mode === "notifications" || mode === "notifications-and-sound";
}

let audioContext: AudioContext | undefined;
const buffers = new Map<string, Promise<AudioBuffer>>();

/** Called from a gesture so browsers allow later background playback. */
export function unlockNotificationAudio() {
  audioContext ??= new AudioContext();
  void audioContext.resume().catch(() => undefined);
}

export async function playNotificationSound(sound: CompletionSound, shouldPlay: () => boolean) {
  if (!audioContext || audioContext.state !== "running") return;
  const context = audioContext;
  const sample = completionSoundSample(sound);
  if (!sample) return;
  const { url, volume } = sample;
  try {
    let buffer = buffers.get(url);
    if (!buffer) {
      buffer = fetch(url)
        .then((response) => response.arrayBuffer())
        .then((data) => context.decodeAudioData(data));
      buffers.set(url, buffer);
    }
    const decoded = await buffer;
    if (!shouldPlay() || context.state !== "running") return;
    const source = context.createBufferSource();
    source.buffer = decoded;
    const gain = context.createGain();
    gain.gain.value = volume;
    source.connect(gain);
    gain.connect(context.destination);
    source.start();
  } catch {
    buffers.delete(url);
  }
}
