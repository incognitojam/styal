import { describe, expect, it } from "vite-plus/test";

import {
  createDeviceStreamStatsTracker,
  deviceStreamUsageSummary,
  STALL_GAP_MS,
} from "./streamStats.ts";

const clock = () => {
  let time = 0;
  return { now: () => time, advance: (ms: number) => void (time += ms) };
};

describe("device stream stats", () => {
  it("reports delay growth only once every frame in a second arrives late", () => {
    const time = clock();
    const stats = createDeviceStreamStatsTracker("h264", time.now);
    // On-time frames 100 ms apart, then every frame arrives 300 ms late.
    for (let frame = 0; frame < 10; frame++) {
      stats.videoReceived(1_000, frame * 100_000);
      time.advance(100);
    }
    expect(stats.snapshot().addedDelayMs).toBe(0);
    time.advance(300);
    for (let frame = 10; frame < 20; frame++) {
      stats.videoReceived(1_000, frame * 100_000);
      // The last on-time frame leaves the one-second window at frame 17.
      expect(stats.snapshot().addedDelayMs).toBe(frame < 17 ? 0 : 300);
      time.advance(100);
    }
    expect(stats.snapshot().maxAddedDelayMs).toBe(300);
  });

  it("reports no delay while a still screen sends sparse, held-back frames", () => {
    const time = clock();
    const stats = createDeviceStreamStatsTracker("h264", time.now);
    for (let frame = 0; frame < 6; frame++) {
      // Two frames a second, each held 400 ms by the encoder.
      time.advance(400);
      stats.videoReceived(1_000, frame * 500_000);
      time.advance(100);
    }
    expect(stats.snapshot()).toMatchObject({ addedDelayMs: null, maxAddedDelayMs: null });
  });

  it("measures delay again once the screen moves", () => {
    const time = clock();
    const stats = createDeviceStreamStatsTracker("h264", time.now);
    for (let frame = 0; frame < 4; frame++) {
      stats.videoReceived(1_000, frame * 100_000);
      time.advance(100);
    }
    expect(stats.snapshot().addedDelayMs).toBeNull();
    stats.videoReceived(1_000, 400_000);
    expect(stats.snapshot().addedDelayMs).toBe(0);
  });

  it("starts a new delay baseline when device timestamps restart", () => {
    const time = clock();
    const stats = createDeviceStreamStatsTracker("h264", time.now);
    stats.videoReceived(1_000, 5_000_000);
    time.advance(500);
    stats.restartTiming();
    for (let frame = 0; frame < 5; frame++) {
      stats.videoReceived(1_000, frame * 100_000);
      time.advance(100);
    }
    expect(stats.snapshot().addedDelayMs).toBe(0);
  });

  it("counts pauses only on the Android stream, where still screens keep sending video", () => {
    const time = clock();
    const android = createDeviceStreamStatsTracker("h264", time.now);
    const ios = createDeviceStreamStatsTracker("avcc", time.now);
    for (const stats of [android, ios]) stats.videoReceived(1_000, null);
    time.advance(STALL_GAP_MS + 500);
    for (const stats of [android, ios]) stats.videoReceived(1_000, null);
    expect(android.snapshot()).toMatchObject({ stalls: 1, longestGapMs: STALL_GAP_MS + 500 });
    expect(ios.snapshot()).toMatchObject({ stalls: null, longestGapMs: null });
  });

  it("reports frames and data from the last second only", () => {
    const time = clock();
    const stats = createDeviceStreamStatsTracker("h264", time.now);
    stats.videoReceived(125_000, null);
    stats.frameShown();
    time.advance(500);
    stats.frameShown();
    expect(stats.snapshot()).toMatchObject({ fps: 2, receivedKbps: 1_000, framesShown: 2 });
    time.advance(800);
    expect(stats.snapshot()).toMatchObject({ fps: 1, receivedKbps: 0, framesShown: 2 });
  });

  it("summarizes a session for usage reporting without addresses", () => {
    const time = clock();
    const stats = createDeviceStreamStatsTracker("h264", time.now);
    stats.videoReceived(1_000, 0);
    stats.frameShown();
    stats.decoderReset();
    time.advance(10_000);
    expect(deviceStreamUsageSummary(stats.snapshot(), "android", "ws://100.64.1.2:3773")).toEqual({
      feature: "device-stream-health",
      action: "session_ended",
      platform: "android",
      transport: "h264",
      connection: "network",
      durationSeconds: 10,
      averageFps: 0,
      decoderResets: 1,
      reconnects: 0,
      stalls: 0,
      longestGapMs: 0,
      maxAddedDelayMs: null,
    });
    expect(
      deviceStreamUsageSummary(stats.snapshot(), "android", "ws://127.0.0.1:3773")?.connection,
    ).toBe("loopback");
  });

  it("skips sessions that never showed video or closed within seconds", () => {
    const time = clock();
    const empty = createDeviceStreamStatsTracker("h264", time.now);
    time.advance(30_000);
    expect(deviceStreamUsageSummary(empty.snapshot(), "android", "ws://localhost")).toBeNull();
    const brief = createDeviceStreamStatsTracker("h264", time.now);
    brief.frameShown();
    time.advance(2_000);
    expect(deviceStreamUsageSummary(brief.snapshot(), "android", "ws://localhost")).toBeNull();
  });
});
