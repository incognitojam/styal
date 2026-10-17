import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

interface FakeBuffer {
  readonly label: string;
  readonly length: number;
  getChannelData(): Float32Array;
}

const audio = vi.hoisted(() => ({
  running: true,
  /** Every sound started, in order; `end` finishes it as the hardware would. */
  sounds: [] as Array<{ label: string; end: () => void; stopped: boolean }>,
}));

function buffer(label: string, length = 400): FakeBuffer {
  const data = new Float32Array(length);
  return { label, length, getChannelData: () => data };
}

const context = {
  sampleRate: 1000,
  destination: {},
  createGain: () => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }),
  createBuffer: (_channels: number, length: number) => buffer("sentence", length),
  createBufferSource: () => {
    let ended = () => {};
    const source = {
      buffer: null as FakeBuffer | null,
      connect: vi.fn(),
      disconnect: vi.fn(),
      addEventListener: (_type: string, listener: () => void) => {
        ended = listener;
      },
      start: () => {
        const sound = { label: source.buffer!.label, end: () => ended(), stopped: false };
        audio.sounds.push(sound);
        source.stop = () => {
          sound.stopped = true;
          ended();
        };
      },
      stop: () => {},
    };
    return source;
  },
};

vi.mock("./threadNotifications", () => ({
  runningNotificationAudio: () => (audio.running ? context : undefined),
  loadNotificationBuffer: async (_context: unknown, url: string) =>
    buffer(url.includes("departures") ? "opening" : url.includes("close") ? "closing" : "phrase"),
}));

let announcer: typeof import("./announcer");

/** Lets the player's awaited loads and plays settle. */
async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Finishes the sound now playing and lets the player move on. */
async function finish() {
  audio.sounds.at(-1)!.end();
  await settle();
}

function board() {
  return announcer.getAnnouncerPlayback().lines.map(({ text, status }) => `${status}: ${text}`);
}

function labels() {
  return audio.sounds.map(({ label }) => label);
}

beforeEach(async () => {
  vi.resetModules();
  audio.running = true;
  audio.sounds.length = 0;
  announcer = await import("./announcer");
});

afterEach(() => announcer.announcerPlayer.stop());

it("plays queued PRs in turn between one opening and one closing chime, listing every line", async () => {
  const { announcerPlayer } = announcer;
  announcerPlayer.announce({ key: "a", number: 1, kind: "departed" });
  announcerPlayer.announce({ key: "b", number: 2, kind: "ci-failure" });
  await settle();
  expect(labels()).toEqual(["opening"]);
  expect(board()).toEqual([
    "queued: Pull request #1 has departed.",
    "queued: Pull request #2 is delayed due to a CI failure.",
  ]);

  await finish();
  expect(labels()).toEqual(["opening", "sentence"]);
  expect(board()).toEqual([
    "speaking: Pull request #1 has departed.",
    "queued: Pull request #2 is delayed due to a CI failure.",
  ]);

  await finish();
  expect(board()).toEqual([
    "spoken: Pull request #1 has departed.",
    "speaking: Pull request #2 is delayed due to a CI failure.",
  ]);

  await finish();
  expect(labels()).toEqual(["opening", "sentence", "sentence", "closing"]);
  // Spoken lines stay up through the closing chime.
  expect(board()).toEqual([
    "spoken: Pull request #1 has departed.",
    "spoken: Pull request #2 is delayed due to a CI failure.",
  ]);

  await finish();
  expect(announcer.getAnnouncerPlayback()).toMatchObject({ playing: false, lines: [] });
});

it("replaces a queued PR's line in place when its status changes again", async () => {
  const { announcerPlayer } = announcer;
  announcerPlayer.announce({ key: "a", number: 1, kind: "ci-failure" });
  announcerPlayer.announce({ key: "b", number: 2, kind: "departed" });
  announcerPlayer.announce({ key: "a", number: 1, kind: "merge-conflict" });
  await settle();
  expect(board()).toEqual([
    "queued: Pull request #1 is delayed due to a merge conflict.",
    "queued: Pull request #2 has departed.",
  ]);
});

it("skips the chimes when every queued line goes stale before it is spoken", async () => {
  const { announcerPlayer } = announcer;
  announcerPlayer.announce({ key: "a", number: 1, kind: "ci-failure" });
  await settle();
  announcerPlayer.reconcile(new Map([["a", null]]));
  await settle();
  expect(audio.sounds.map(({ stopped }) => stopped)).toEqual([true]);
  expect(labels()).toEqual(["opening"]);
  expect(announcer.getAnnouncerPlayback()).toMatchObject({ playing: false, lines: [] });
});

it("cuts off a line whose PR changed mid-speech and leaves it off the board", async () => {
  const { announcerPlayer } = announcer;
  announcerPlayer.announce({ key: "a", number: 1, kind: "ci-failure" });
  announcerPlayer.announce({ key: "b", number: 2, kind: "departed" });
  await settle();
  await finish();
  announcerPlayer.reconcile(
    new Map([
      ["a", null],
      ["b", "departed"],
    ]),
  );
  await settle();
  expect(audio.sounds[1]!.stopped).toBe(true);
  expect(board()).toEqual(["speaking: Pull request #2 has departed."]);
});

it("stops everything at once, including what is queued", async () => {
  const { announcerPlayer } = announcer;
  announcerPlayer.announce({ key: "a", number: 1, kind: "departed" });
  announcerPlayer.announce({ key: "b", number: 2, kind: "departed" });
  await settle();
  await finish();
  announcerPlayer.stop();
  await settle();
  expect(labels()).toEqual(["opening", "sentence"]);
  expect(announcer.getAnnouncerPlayback()).toMatchObject({ playing: false, lines: [] });
});

it("says nothing until a gesture has unlocked notification audio", async () => {
  audio.running = false;
  announcer.announcerPlayer.announce({ key: "a", number: 1, kind: "departed" });
  await settle();
  expect(labels()).toEqual([]);
  expect(announcer.getAnnouncerPlayback().playing).toBe(false);
});
