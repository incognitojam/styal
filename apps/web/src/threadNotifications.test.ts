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
  { sound: "resolve", url: "/resolve.wav", volume: 1 },
  { sound: "avanti", url: "/avanti.mp3", volume: 0.28 },
] as const)(
  "uses the selected $sound sample and normalized level",
  async ({ sound, url, volume }) => {
    const { unlockNotificationAudio, playNotificationSound } =
      await import("./threadNotifications");
    unlockNotificationAudio();
    await playNotificationSound(sound, () => true);
    await playNotificationSound(sound, () => true);
    expect(fetchSample).toHaveBeenCalledExactlyOnceWith(url);
    expect(gain.gain.value).toBe(volume);
    expect(start).toHaveBeenCalledTimes(2);
  },
);

it("suppresses playback before a gesture, for None, and when preferences change during decode", async () => {
  const { unlockNotificationAudio, playNotificationSound } = await import("./threadNotifications");
  await playNotificationSound("resolve", () => true);
  expect(fetchSample).not.toHaveBeenCalled();
  unlockNotificationAudio();
  await playNotificationSound("none", () => true);
  expect(fetchSample).not.toHaveBeenCalled();
  await playNotificationSound("resolve", () => false);
  expect(start).not.toHaveBeenCalled();
});
