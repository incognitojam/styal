import { useEffect, useMemo, useState } from "react";
import { deriveDiscordPresence } from "../discordPresence";
import { useEnvironmentShellStatuses, useServerConfigs, useThreadShells } from "../state/entities";
import { useNowMinute } from "./useNowMinute";

/** The activity Discord would show right now, re-derived when a snoozed thread wakes. */
export function useDiscordPresenceActivity() {
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

  useEffect(() => {
    if (nextWakeAt === null) return;
    const timer = window.setTimeout(
      () => setWakeTime(Date.now()),
      Math.min(Math.max(0, nextWakeAt - Date.now()) + 50, 2_147_483_647),
    );
    return () => window.clearTimeout(timer);
  }, [nextWakeAt, wakeTime]);
  return activity;
}
