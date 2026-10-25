// @effect-diagnostics globalTimers:off globalDate:off - Visible-viewer recovery runs in browser and native hooks outside an Effect runtime.

// Peer environments do not push inventory updates. Only a failed, visible viewer
// checks for a completed restart, and stops after the longest profile deadline.
export function watchSimulatorRestart(
  revision: string | undefined,
  readRevision: () => Promise<string | undefined>,
) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const deadline = Date.now() + 30 * 60_000;
  const check = async () => {
    try {
      const next = await readRevision();
      if (next !== undefined && next !== revision) return;
    } catch {
      // A reboot or temporarily unavailable peer can fail discovery too.
    }
    if (!stopped && Date.now() < deadline) timer = setTimeout(check, 10_000);
  };
  timer = setTimeout(check, 10_000);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
