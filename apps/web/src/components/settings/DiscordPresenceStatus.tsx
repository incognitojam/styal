import type { DesktopDiscordPresenceStatus } from "@t3tools/contracts";
import { cn } from "~/lib/utils";
import { useDiscordPresenceActivity } from "../../hooks/useDiscordPresenceActivity";
import { useDiscordPresenceStatus } from "../../hooks/useDiscordPresenceStatus";

function describe(status: DesktopDiscordPresenceStatus) {
  switch (status._tag) {
    case "connected":
      return {
        dot: "bg-success",
        text: `Sharing as @${status.username}. If friends can't see it, check Activity Privacy in Discord's settings.`,
      };
    case "connecting":
      return { dot: "bg-warning", text: "Connecting to Discord…" };
    case "unavailable":
      return {
        dot: "bg-destructive",
        text: "Can't reach Discord. Open the Discord desktop app; styal keeps trying.",
      };
    case "idle":
      return { dot: "bg-muted-foreground/50", text: "Nothing shared while no threads are active." };
  }
}

/** Whether the desktop app is actually reaching Discord, shown under the toggle. */
export function DiscordPresenceStatus() {
  const status = useDiscordPresenceStatus();
  const activity = useDiscordPresenceActivity();
  if (!status) return null;
  // Desktop is idle until the first counts arrive, which with active threads is a moment away.
  const { dot, text } = describe(
    status._tag === "idle" && activity ? { _tag: "connecting" } : status,
  );
  return (
    <span role="status" aria-live="polite" className="inline-flex items-start gap-1.5">
      <span aria-hidden className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", dot)} />
      {text}
    </span>
  );
}
