import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ClientSettings, NotificationSound } from "@t3tools/contracts/settings";

import completionUrl from "./assets/notification-completion.mp3";
import departuresUrl from "./assets/notification-departures.mp3";
import inputUrl from "./assets/notification-input.mp3";

export const NOTIFICATION_SOUND_LABELS = {
  "t3-completion": "styal completion",
  "t3-input": "styal attention",
  avanti: "Avanti",
  departures: "Departures",
  none: "None",
} satisfies Record<NotificationSound, string>;

const NOTIFICATION_SOUND_URLS = {
  "t3-completion": completionUrl,
  "t3-input": inputUrl,
  avanti: "/avanti.mp3",
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

/** The mode that turns system notifications and sounds on or off independently. */
export function notificationModeFor(desktop: boolean, sound: boolean): NotificationMode {
  if (desktop) return sound ? "notifications-and-sound" : "notifications";
  return sound ? "sound" : "off";
}

let audioContext: AudioContext | undefined;
const buffers = new Map<string, Promise<AudioBuffer>>();
/** When each sound's current playback ends, on the audio context's clock. */
const playingUntil = new Map<string, number>();
let activeSounds = 0;
/** A gesture has started audio, so later contexts may start without one. */
let unlocked = false;

// The context stays suspended between sounds. A running context renders silence nonstop and holds
// the output device, and Chromium can leave it attached to a device that has gone away (a
// Bluetooth headset switching in). Each resume opens a fresh stream on the current default device.
function releaseOutputWhenIdle(context: AudioContext) {
  if (activeSounds === 0) void context.suspend().catch(() => undefined);
}

function discardContext(context: AudioContext) {
  if (audioContext !== context) return;
  audioContext = undefined;
  activeSounds = 0;
  playingUntil.clear();
  void context.close().catch(() => undefined);
}

/**
 * The first AudioContext in a renderer blocks for tens of milliseconds, so it is built while the
 * app is idle instead of in the first input handler. Electron allows autoplay, so it starts running.
 */
export function prepareNotificationAudio() {
  if (audioContext) return;
  audioContext = new AudioContext();
  if (audioContext.state === "running") releaseOutputWhenIdle(audioContext);
}

/** Called from a gesture so browsers allow later background playback. */
export async function unlockNotificationAudio() {
  if (unlocked) return;
  audioContext ??= new AudioContext();
  const context = audioContext;
  try {
    await context.resume();
    unlocked = true;
    releaseOutputWhenIdle(context);
  } catch (error) {
    console.warn("Notification audio could not start", error);
    discardContext(context);
  }
}

export async function playNotificationSound(
  kind: "completion" | "input",
  shouldPlay: () => boolean,
  sound: NotificationSound = kind === "completion" ? "t3-completion" : "t3-input",
) {
  if (!unlocked || sound === "none") return;
  // A context discarded after a failed resume is replaced here, so one bad device does not
  // silence alerts until the next click.
  audioContext ??= new AudioContext();
  const context = audioContext;
  const url = NOTIFICATION_SOUND_URLS[sound];
  let decoded: AudioBuffer;
  try {
    let buffer = buffers.get(url);
    if (!buffer) {
      buffer = fetch(url)
        .then((response) => response.arrayBuffer())
        .then((data) => context.decodeAudioData(data));
      buffers.set(url, buffer);
    }
    decoded = await buffer;
  } catch (error) {
    buffers.delete(url);
    console.warn("Notification sound could not load", url, error);
    return;
  }
  if (audioContext !== context) return;
  if (!shouldPlay()) {
    releaseOutputWhenIdle(context);
    return;
  }
  // Threads that finish together each ask for this sound, and full-volume copies sum into
  // clipping. One playback stands for the burst, claimed before resuming so concurrent callers
  // see it. The other kind keeps its own slot, so an input alert is still heard over a completion.
  const slot = `${kind}:${url}`;
  if (context.currentTime < (playingUntil.get(slot) ?? 0)) return;
  playingUntil.set(slot, context.currentTime + decoded.duration);
  activeSounds += 1;
  try {
    await context.resume();
    if (context.state !== "running") throw new Error(`AudioContext is ${context.state}`);
  } catch (error) {
    activeSounds -= 1;
    console.warn("Notification audio could not resume", error);
    discardContext(context);
    return;
  }
  const source = context.createBufferSource();
  source.buffer = decoded;
  const gain = context.createGain();
  gain.gain.value = sound === "avanti" ? 0.28 : 1;
  source.connect(gain);
  gain.connect(context.destination);
  source.addEventListener("ended", () => {
    if (audioContext !== context) return;
    activeSounds -= 1;
    releaseOutputWhenIdle(context);
  });
  source.start();
}
