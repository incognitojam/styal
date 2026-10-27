import type { DesktopDiscordPresenceStatus } from "@t3tools/contracts";
import { useEffect, useState } from "react";

/** The desktop's live connection to Discord, or null outside the desktop app. */
export function useDiscordPresenceStatus() {
  const [status, setStatus] = useState<DesktopDiscordPresenceStatus | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads and subscribes to Discord presence status from the Electron bridge
  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge?.getDiscordPresenceStatus || !bridge.onDiscordPresenceStatus) return;
    let pushed = false;
    let active = true;
    const unsubscribe = bridge.onDiscordPresenceStatus((next) => {
      pushed = true;
      setStatus(next);
    });
    void bridge
      .getDiscordPresenceStatus()
      .then((initial) => {
        if (active && !pushed) setStatus(initial);
      })
      .catch(() => undefined);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return status;
}
