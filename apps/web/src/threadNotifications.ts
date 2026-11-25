import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ClientSettings, NotificationSound } from "@t3tools/contracts/settings";
import { msg } from "gt-react";

import completionUrl from "./assets/notification-completion.mp3";
import inputUrl from "./assets/notification-input.mp3";

import departuresUrl from "./assets/notification-departures.mp3";
import avantiUrl from "./assets/notification-avanti.mp3";

export const NOTIFICATION_SOUND_LABELS = {
  "t3-completion": msg("styal completion"),
  "t3-input": msg("styal attention"),
  avanti: "Avanti",
  departures: "Departures",
  none: msg("None"),
} satisfies Record<NotificationSound, string>;
const NOTIFICATION_SOUND_URLS = {
  "t3-completion": completionUrl,
  "t3-input": inputUrl,
  avanti: avantiUrl,
  departures: departuresUrl,
} satisfies Record<Exclude<NotificationSound, "none">, string>;
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
  off: msg("Off", { $context: "notification setting, no notifications or sound" }),
  notifications: msg("Notifications only"),
  sound: msg("Sound only"),
  "notifications-and-sound": msg("Notifications with sound"),
} satisfies Record<NotificationMode, string>;

export function hasNotificationSound(mode: NotificationMode) {
  return mode === "sound" || mode === "notifications-and-sound";
}

export function hasDesktopNotifications(mode: NotificationMode) {
  return mode === "notifications" || mode === "notifications-and-sound";
}

const TAG_HASH_OFFSET_BASIS = 0xcbf29ce484222325n;
const TAG_HASH_PRIME = 0x100000001b3n;
const TAG_HASH_MASK = 0xffffffffffffffffn;

/** Windows drops toast notifications with the 73-character environment/thread tag. */
export function threadNotificationTag(environmentId: EnvironmentId, threadId: ThreadId): string {
  const key = `${environmentId}:${threadId}`;
  let hash = TAG_HASH_OFFSET_BASIS;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= BigInt(key.charCodeAt(index));
    hash = (hash * TAG_HASH_PRIME) & TAG_HASH_MASK;
  }
  return hash.toString(16).padStart(16, "0");
}

let originalFavicon: HTMLLinkElement | undefined;
let badgeFavicon: HTMLLinkElement | undefined;

export function setNotificationBadge(count: number) {
  const bridge = window.desktopBridge;
  let image: string | null = null;
  if (count > 0 && (!bridge || bridge.getClientPlatform() === "win32")) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const context = canvas.getContext("2d");
    if (context) {
      context.fillStyle = "#e5484d";
      context.beginPath();
      context.arc(32, 32, 28, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = "white";
      context.font = `600 ${count > 9 ? 30 : 40}px "Segoe UI", sans-serif`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(count > 9 ? "9+" : String(count), 32, 34);
      image = canvas.toDataURL("image/png");
    }
  }
  if (!bridge) {
    if (image) {
      if (!badgeFavicon) {
        originalFavicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]') ?? undefined;
        badgeFavicon = document.createElement("link");
        badgeFavicon.rel = "icon";
        badgeFavicon.type = "image/png";
        badgeFavicon.sizes.value = "64x64";
        originalFavicon?.remove();
        document.head.append(badgeFavicon);
      }
      badgeFavicon.href = image;
    } else if (badgeFavicon) {
      badgeFavicon.remove();
      badgeFavicon = undefined;
      if (originalFavicon) document.head.append(originalFavicon);
      originalFavicon = undefined;
    }
  }
  void bridge?.setNotificationBadge({ count, image }).catch(() => undefined);
}

let audioContext: AudioContext | undefined;
const buffers = new Map<string, Promise<AudioBuffer>>();
/** When each sound's current playback ends, on the audio context's clock. */
const playingUntil = new Map<string, number>();

function loadNotificationBuffer(context: AudioContext, url: string): Promise<AudioBuffer> {
  let buffer = buffers.get(url);
  if (!buffer) {
    buffer = fetch(url)
      .then((response) => response.arrayBuffer())
      .then((data) => context.decodeAudioData(data))
      .catch((error: unknown) => {
        buffers.delete(url);
        throw error;
      });
    buffers.set(url, buffer);
  }
  return buffer;
}

/** Called from a gesture so browsers allow later background playback. */
export function unlockNotificationAudio() {
  const firstUnlock = audioContext === undefined;
  audioContext ??= new AudioContext();
  const resumed = audioContext.resume().catch(() => undefined);
  if (!firstUnlock) return resumed;
  // Fetch and decode during interaction so the first alert is ready when the thread finishes.
  for (const url of [completionUrl, inputUrl]) {
    void loadNotificationBuffer(audioContext, url).catch(() => undefined);
  }
  return resumed;
}

export async function playNotificationSound(
  kind: "completion" | "input",
  shouldPlay: () => boolean,
  sound: NotificationSound = kind === "completion" ? "t3-completion" : "t3-input",
) {
  if (!audioContext || audioContext.state !== "running" || sound === "none") return;
  const context = audioContext;
  const url = NOTIFICATION_SOUND_URLS[sound];
  try {
    const decoded = await loadNotificationBuffer(context, url);
    if (!shouldPlay() || context.state !== "running") return;
    // Coalesce same-sound bursts after decode to avoid clipping; input and completion alerts keep separate slots.
    const slot = `${kind}:${url}`;
    if (context.currentTime < (playingUntil.get(slot) ?? 0)) return;
    const source = context.createBufferSource();
    source.buffer = decoded;
    const gain = context.createGain();
    gain.gain.value = sound === "avanti" ? 0.28 : 1;
    source.connect(gain);
    gain.connect(context.destination);
    source.start();
    playingUntil.set(slot, context.currentTime + decoded.duration);
  } catch {
    // A failed load is retried on the next alert.
  }
}
