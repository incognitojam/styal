export interface ExecutableBrowserWebview extends Element {
  readonly executeJavaScript: (code: string, userGesture?: boolean) => Promise<unknown>;
}

export const BROWSER_CAPTURE_SURFACE_TIMEOUT_MS = 5_000;

export const findBrowserWebview = (tabId: string): ExecutableBrowserWebview | null =>
  Array.from(document.querySelectorAll<ExecutableBrowserWebview>("webview[data-preview-tab]")).find(
    (candidate) => candidate.getAttribute("data-preview-tab") === tabId,
  ) ?? null;

const findBrowserCaptureSurface = (tabId: string): HTMLElement | null =>
  Array.from(document.querySelectorAll<HTMLElement>("[data-preview-capture-surface]")).find(
    (candidate) => candidate.getAttribute("data-preview-viewport") === tabId,
  ) ?? null;

export async function waitForBrowserCaptureSurface(
  tabId: string,
  options: {
    readonly timeoutMs?: number;
    readonly assertCurrent?: () => void;
  } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? BROWSER_CAPTURE_SURFACE_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    options.assertCurrent?.();
    const surface = findBrowserCaptureSurface(tabId);
    const webview = findBrowserWebview(tabId);
    if (surface && webview) {
      const remainingMs = Math.max(0, deadline - Date.now());
      const painted = await new Promise<boolean>((resolve) => {
        let settled = false;
        const settle = (value: boolean) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeout);
          resolve(value);
        };
        const timeout = window.setTimeout(() => settle(false), remainingMs);
        void webview
          .executeJavaScript(
            "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))",
          )
          .then(
            () => settle(true),
            () => settle(false),
          );
      });
      if (painted) {
        options.assertCurrent?.();
        return true;
      }
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 16));
  }
  return false;
}
