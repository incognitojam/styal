import { useEffect } from "react";
import { useDiscordPresenceActivity } from "../../hooks/useDiscordPresenceActivity";
import { useClientSettings } from "../../hooks/useSettings";

export function DiscordPresenceSync() {
  const enabled = useClientSettings((settings) => settings.discordRichPresence);
  return enabled && window.desktopBridge?.setDiscordPresence ? <ActiveDiscordPresenceSync /> : null;
}

function ActiveDiscordPresenceSync() {
  const activity = useDiscordPresenceActivity();
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

  return null;
}
