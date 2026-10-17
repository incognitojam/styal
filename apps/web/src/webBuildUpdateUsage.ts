import type { WebBuildUpdateUsageAction } from "@t3tools/contracts";

/** Returns nothing when the report is unsupported; otherwise resolves to whether it was received. */
type Reporter = (action: WebBuildUpdateUsageAction) => Promise<boolean> | undefined;
const REPORT_WAIT_MS = 200;
// A reload the browser cancels or blocks leaves the page open; allow another attempt.
const RELOAD_RETRY_MS = 2_000;

/** Keep each build's exposure and click on one environment, even if the primary changes. */
export function createWebBuildUpdateUsage(reload: () => void) {
  const exposed = new Map<string, Reporter>();
  let refreshing = false;

  return {
    noticeShown(buildId: string, report: Reporter | undefined) {
      if (!report || exposed.has(buildId)) return;
      // Only a received report counts; a skipped or failed one lets a later sighting try again.
      let pending: Promise<boolean> | undefined;
      try {
        pending = report("notice_shown");
      } catch {
        return;
      }
      if (!pending) return;
      exposed.set(buildId, report);
      const forget = () => {
        if (exposed.get(buildId) === report) exposed.delete(buildId);
      };
      pending.then((received) => {
        if (!received) forget();
      }, forget);
    },
    async refresh(buildId: string, report: Reporter | undefined) {
      if (refreshing) return;
      refreshing = true;
      const reporter = exposed.get(buildId) ?? report;
      if (reporter) {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          // Give the server a brief chance to buffer the event before the socket closes.
          await Promise.race([
            Promise.resolve().then(() => reporter("refresh_requested")),
            new Promise<void>((resolve) => {
              timeout = setTimeout(resolve, REPORT_WAIT_MS);
            }),
          ]);
        } catch {
          // Reporting is best effort; refreshing never depends on telemetry succeeding.
        } finally {
          clearTimeout(timeout);
        }
      }
      reload();
      setTimeout(() => {
        refreshing = false;
      }, RELOAD_RETRY_MS);
    },
  };
}

/** A mounted offscreen sidebar or a background tab is not a notice exposure. */
export function observeWebBuildUpdateNotice(element: Element, onShown: () => void) {
  let intersects = false;
  const report = () => {
    if (intersects && document.visibilityState === "visible") onShown();
  };
  const observer = new IntersectionObserver((entries) => {
    intersects = entries.some((entry) => entry.isIntersecting);
    report();
  });
  observer.observe(element);
  document.addEventListener("visibilitychange", report);
  return () => {
    observer.disconnect();
    document.removeEventListener("visibilitychange", report);
  };
}
