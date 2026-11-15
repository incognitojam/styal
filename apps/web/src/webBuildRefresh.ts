// A reload the browser cancels or blocks leaves the page open; allow another attempt.
const RELOAD_RETRY_MS = 2_000;

export function createWebBuildRefresh(reload: () => void) {
  let refreshing = false;
  return () => {
    if (refreshing) return;
    refreshing = true;
    reload();
    setTimeout(() => {
      refreshing = false;
    }, RELOAD_RETRY_MS);
  };
}
