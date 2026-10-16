import type { WebBuildUpdateUsageAction } from "@t3tools/contracts";

type Reporter = (action: WebBuildUpdateUsageAction) => Promise<unknown>;
const REPORT_WAIT_MS = 200;

/** Keep each build's exposure and click on one environment, even if the primary changes. */
export function createWebBuildUpdateUsage(reload: () => void) {
  const exposed = new Map<string, Reporter>();
  let refreshing = false;

  return {
    noticeShown(buildId: string, report: Reporter | undefined) {
      if (!report || exposed.has(buildId)) return;
      exposed.set(buildId, report);
      void Promise.resolve()
        .then(() => report("notice_shown"))
        .catch(() => {});
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
