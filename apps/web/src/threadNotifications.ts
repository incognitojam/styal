import type { ClientSettings, NotificationSound } from "@t3tools/contracts/settings";

import completionUrl from "./assets/notification-completion.mp3";
import inputUrl from "./assets/notification-input.mp3";

export const NOTIFICATION_SOUND_LABELS = {
  "t3-completion": "T3 completion",
  "t3-input": "T3 attention",
  avanti: "Avanti",
  none: "None",
} satisfies Record<NotificationSound, string>;

export function notificationSoundForEvent(
  settings: Pick<ClientSettings, "completionSound" | "inputSound" | "approvalSound">,
  event: "completion" | "input" | "approval",
) {
  return event === "completion"
    ? settings.completionSound
    : event === "approval"
      ? settings.approvalSound
      : settings.inputSound;
}

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
  return audioContext.resume().catch(() => undefined);
}

export async function playNotificationSound(
  kind: "completion" | "input",
  shouldPlay: () => boolean,
  sound: NotificationSound = kind === "completion" ? "t3-completion" : "t3-input",
) {
  if (!audioContext || audioContext.state !== "running") return;
  const context = audioContext;
  if (sound === "none") return;
  const url =
    sound === "avanti" ? "/avanti.mp3" : sound === "t3-completion" ? completionUrl : inputUrl;
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
    gain.gain.value = sound === "avanti" ? 0.28 : 1;
    source.connect(gain);
    gain.connect(context.destination);
    source.start();
  } catch {
    buffers.delete(url);
  }
}
