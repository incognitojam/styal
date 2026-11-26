const CHECK_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

/** Watches the page's deployment, independently of any paired server. Stop on renderer unmount. */
export function watchWebBuildUpdates(
  buildId: string,
  onChange: (availableBuildId: string | null) => void,
) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let request: AbortController | undefined;
  const canCheck = () => document.visibilityState === "visible" && navigator.onLine;
  const clearTimer = () => clearTimeout(timer);

  const check = async () => {
    if (stopped || request || !canCheck()) return;
    clearTimer();
    const controller = new AbortController();
    request = controller;
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(new URL("/build.json", window.location.origin), {
        cache: "no-store",
        signal: controller.signal,
      });
      // Older servers and removed previews may return the SPA fallback here.
      if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
        return;
      }
      const manifest: unknown = await response.json();
      if (
        !stopped &&
        !controller.signal.aborted &&
        typeof manifest === "object" &&
        manifest !== null &&
        "buildId" in manifest &&
        typeof manifest.buildId === "string" &&
        manifest.buildId.trim().length > 0
      ) {
        onChange(manifest.buildId !== buildId ? manifest.buildId : null);
      }
    } catch {
      // A failed check should neither interrupt work nor erase an existing update notice.
    } finally {
      clearTimeout(timeout);
      request = undefined;
      if (!stopped && canCheck()) timer = setTimeout(() => void check(), CHECK_INTERVAL_MS);
    }
  };

  const resume = () => {
    if (canCheck()) void check();
    else {
      clearTimer();
      request?.abort();
    }
  };

  document.addEventListener("visibilitychange", resume);
  window.addEventListener("focus", resume);
  window.addEventListener("online", resume);
  window.addEventListener("offline", resume);
  void check();

  return () => {
    stopped = true;
    clearTimer();
    request?.abort();
    document.removeEventListener("visibilitychange", resume);
    window.removeEventListener("focus", resume);
    window.removeEventListener("online", resume);
    window.removeEventListener("offline", resume);
  };
}
