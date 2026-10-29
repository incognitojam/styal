// @effect-diagnostics globalDate:off globalTimers:off - Scheduling for React hooks outside an Effect runtime; reports store ISO timestamps.
export const SETTINGS_SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Whether a day has passed since the last accepted report, or none was ever stored. */
export function isSettingsSnapshotDue(lastReportedAt: string | null, now: number): boolean {
  const last = lastReportedAt === null ? Number.NaN : Date.parse(lastReportedAt);
  // A missing, unreadable or future timestamp reports again rather than never.
  return !(last <= now && now - last < SETTINGS_SNAPSHOT_INTERVAL_MS);
}

const FIRST_RETRY_DELAY_MS = 60 * 1000;
const LONGEST_RETRY_DELAY_MS = 60 * 60 * 1000;

/**
 * How long to wait after `failures` reports in a row went unaccepted. The first
 * retry stays quick because a report can fail before the socket connects; a
 * server that keeps rejecting it is asked at most hourly.
 */
export function settingsSnapshotRetryDelayMs(failures: number): number {
  return Math.min(FIRST_RETRY_DELAY_MS * 2 ** Math.max(failures - 1, 0), LONGEST_RETRY_DELAY_MS);
}

// A check is one storage read. Checking often retries soon after a report that
// failed because the cached server config arrived before the socket connected.
const CHECK_INTERVAL_MS = 60 * 1000;

export interface SettingsSnapshotReports {
  readonly readLastReportedAt: () => string | null | Promise<string | null>;
  readonly saveReportedAt: (reportedAt: string) => void | Promise<void>;
  /** Sends the snapshot: undefined when nothing was sent, else whether the server accepted it. */
  readonly report: () => Promise<boolean | undefined> | undefined;
}

/**
 * Reports a device's preferences at most once a day. The day restarts only
 * when a server accepts the report, so storage errors report again rather
 * than never. Returns a function that stops the checks.
 */
export function startSettingsSnapshotReports(reports: SettingsSnapshotReports): () => void {
  let busy = false;
  let failures = 0;
  let retryAt = 0;
  const save = (reportedAt: number) =>
    Promise.resolve()
      .then(() => reports.saveReportedAt(new Date(reportedAt).toISOString()))
      .catch(() => undefined);
  const reportIfDue = async () => {
    const now = Date.now();
    if (busy || now < retryAt) return;
    busy = true;
    try {
      const lastReportedAt = await Promise.resolve()
        .then(reports.readLastReportedAt)
        .catch(() => null);
      if (!isSettingsSnapshotDue(lastReportedAt, now)) return;
      const accepted = await Promise.resolve()
        .then(reports.report)
        .catch(() => false);
      if (accepted === undefined) return;
      if (!accepted) {
        failures += 1;
        // From the attempt, not the reply, so the next check on the interval qualifies.
        retryAt = now + settingsSnapshotRetryDelayMs(failures);
        // Stored as a report a day before the retry, so a reconnect or restart,
        // which starts the count again, still waits for it.
        await save(retryAt - SETTINGS_SNAPSHOT_INTERVAL_MS);
        return;
      }
      failures = 0;
      await save(Date.now());
    } finally {
      busy = false;
    }
  };
  void reportIfDue();
  const timer = setInterval(() => void reportIfDue(), CHECK_INTERVAL_MS);
  return () => clearInterval(timer);
}
