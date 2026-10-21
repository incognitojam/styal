// @effect-diagnostics globalDate:off - Fake timers drive the wall clock the scheduler reads.
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  SETTINGS_SNAPSHOT_INTERVAL_MS,
  isSettingsSnapshotDue,
  settingsSnapshotRetryDelayMs,
  startSettingsSnapshotReports,
} from "./settingsSnapshot.ts";

describe("isSettingsSnapshotDue", () => {
  const now = Date.parse("2026-10-23T12:00:00.000Z");

  it("reports once a day after the last accepted report", () => {
    expect(isSettingsSnapshotDue(null, now)).toBe(true);
    expect(isSettingsSnapshotDue(new Date(now - 60_000).toISOString(), now)).toBe(false);
    expect(
      isSettingsSnapshotDue(new Date(now - SETTINGS_SNAPSHOT_INTERVAL_MS).toISOString(), now),
    ).toBe(true);
  });

  it("reports again after an unreadable or future timestamp instead of never", () => {
    expect(isSettingsSnapshotDue("not a date", now)).toBe(true);
    expect(isSettingsSnapshotDue(new Date(now + 60_000).toISOString(), now)).toBe(true);
  });
});

describe("settingsSnapshotRetryDelayMs", () => {
  it("retries a rejected report after a minute, then backs off to hourly", () => {
    expect(
      [1, 2, 3, 4, 5, 6, 7, 20].map((failures) => settingsSnapshotRetryDelayMs(failures)),
    ).toEqual([1, 2, 4, 8, 16, 32, 60, 60].map((minutes) => minutes * 60_000));
  });
});

describe("startSettingsSnapshotReports", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-10-23T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function schedule(
    replies: Array<boolean | undefined | Error>,
    storage: { stored: string | null } = { stored: null },
  ) {
    const attempts: number[] = [];
    const stop = startSettingsSnapshotReports({
      readLastReportedAt: async () => storage.stored,
      saveReportedAt: async (reportedAt) => {
        storage.stored = reportedAt;
      },
      report: () => {
        attempts.push(vi.getMockedSystemTime()!.getTime());
        const reply = replies.shift();
        if (reply instanceof Error) return Promise.reject(reply);
        return reply === undefined ? undefined : Promise.resolve(reply);
      },
    });
    return { attempts, stop, stored: () => storage.stored };
  }

  it("retries rejected or failed reports with backoff and then waits a day", async () => {
    const { attempts, stop, stored } = schedule([false, new Error("Synthetic"), true, true]);
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempts).toHaveLength(2);
    // The second failure waits two minutes.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempts).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempts).toHaveLength(3);
    expect(stored()).toBe("2026-10-23T12:03:00.000Z");

    await vi.advanceTimersByTimeAsync(SETTINGS_SNAPSHOT_INTERVAL_MS - 60_000);
    expect(attempts).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempts).toHaveLength(4);
    stop();
  });

  it("keeps waiting for a retry after the reporter restarts", async () => {
    const storage = { stored: null };
    const first = schedule([false], storage);
    await vi.advanceTimersByTimeAsync(0);
    first.stop();

    const second = schedule([true], storage);
    await vi.advanceTimersByTimeAsync(0);
    expect(second.attempts).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(second.attempts).toHaveLength(1);
    expect(storage.stored).toBe("2026-10-23T12:01:00.000Z");
    second.stop();
  });

  it("checks again a minute later when no server could take the report", async () => {
    const { attempts, stop, stored } = schedule([undefined, true]);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempts).toHaveLength(2);
    expect(stored()).not.toBeNull();
    stop();
    await vi.advanceTimersByTimeAsync(2 * SETTINGS_SNAPSHOT_INTERVAL_MS);
    expect(attempts).toHaveLength(2);
  });
});
