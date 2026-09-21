import { useEffect, useMemo, useState } from "react";
import { deriveDiscordPresence } from "../../discordPresence";
import { useClientSettings } from "../../hooks/useSettings";
import { useNowMinute } from "../../hooks/useNowMinute";
import {
  useEnvironmentShellStatuses,
  useServerConfigs,
  useThreadShells,
} from "../../state/entities";

export function DiscordPresenceSync() {
  const enabled = useClientSettings((settings) => settings.discordRichPresence);
  return enabled && window.desktopBridge?.setDiscordPresence ? <ActiveDiscordPresenceSync /> : null;
}

function ActiveDiscordPresenceSync() {
  const threads = useThreadShells();
  const serverConfigs = useServerConfigs();
  const shellStatuses = useEnvironmentShellStatuses();
  const nowMinute = useNowMinute();
  const [wakeTime, setWakeTime] = useState(Date.now);
  const now = new Date(Math.max(Date.parse(`${nowMinute}:00.000Z`), wakeTime)).toISOString();
  const { activity, nextWakeAt } = useMemo(
    () =>
      deriveDiscordPresence({
        threads,
        serverConfigs,
        shellStatuses,
        now,
      }),
    [threads, serverConfigs, shellStatuses, now],
  );
  const activeThreads = activity?.activeThreads ?? 0;
  const activeProjects = activity?.activeProjects ?? 0;

  useEffect(() => {
    void window.desktopBridge
      ?.setDiscordPresence?.(activeThreads > 0 ? { activeThreads, activeProjects } : null)
      .catch(() => undefined);
  }, [activeThreads, activeProjects]);

  useEffect(() => {
    const clear = () => {
      void window.desktopBridge?.setDiscordPresence?.(null).catch(() => undefined);
    };
    window.addEventListener("pagehide", clear);
    return () => {
      window.removeEventListener("pagehide", clear);
      clear();
    };
  }, []);

  useEffect(() => {
    if (nextWakeAt === null) return;
    const timer = window.setTimeout(
      () => setWakeTime(Date.now()),
      Math.min(Math.max(0, nextWakeAt - Date.now()) + 50, 2_147_483_647),
    );
    return () => window.clearTimeout(timer);
  }, [nextWakeAt, wakeTime]);
  return null;
}
