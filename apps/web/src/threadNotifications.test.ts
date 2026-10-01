import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const start = vi.fn();
const gain = { gain: { value: 0 }, connect: vi.fn() };
const fetchSample = vi.fn();

beforeEach(() => {
  vi.resetModules();
  start.mockClear();
  fetchSample.mockReset().mockResolvedValue({ arrayBuffer: async () => new ArrayBuffer(0) });
  vi.stubGlobal("fetch", fetchSample);
  vi.stubGlobal(
    "AudioContext",
    class {
      state = "running";
      destination = {};
      resume = async () => {};
      decodeAudioData = async () => ({});
      createBufferSource = () => ({ buffer: null, connect: vi.fn(), start });
      createGain = () => gain;
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

it.each([
  { sound: "t3-completion", url: "/src/assets/notification-completion.mp3", volume: 1 },
  { sound: "t3-input", url: "/src/assets/notification-input.mp3", volume: 1 },
  { sound: "avanti", url: "/avanti.mp3", volume: 0.28 },
] as const)(
  "uses the selected $sound sample and normalized level",
  async ({ sound, url, volume }) => {
    const { unlockNotificationAudio, playNotificationSound } =
      await import("./threadNotifications");
    unlockNotificationAudio();
    await playNotificationSound("completion", () => true, sound);
    await playNotificationSound("completion", () => true, sound);
    expect(fetchSample).toHaveBeenCalledExactlyOnceWith(url);
    expect(gain.gain.value).toBe(volume);
    expect(start).toHaveBeenCalledTimes(2);
  },
);

it("suppresses playback before a gesture, for None, and when preferences change during decode", async () => {
  const { unlockNotificationAudio, playNotificationSound } = await import("./threadNotifications");
  await playNotificationSound("completion", () => true);
  expect(fetchSample).not.toHaveBeenCalled();
  unlockNotificationAudio();
  await playNotificationSound("completion", () => true, "none");
  expect(fetchSample).not.toHaveBeenCalled();
  await playNotificationSound("completion", () => false);
  expect(start).not.toHaveBeenCalled();
});

it("toggles system notifications and sounds without changing the other", async () => {
  const { hasDesktopNotifications, hasNotificationSound, notificationModeFor } =
    await import("./threadNotifications");
  for (const desktop of [false, true]) {
    for (const sound of [false, true]) {
      const mode = notificationModeFor(desktop, sound);
      expect([hasDesktopNotifications(mode), hasNotificationSound(mode)]).toEqual([desktop, sound]);
    }
  }
});
