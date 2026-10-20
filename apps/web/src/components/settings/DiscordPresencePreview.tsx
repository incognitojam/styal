import { DISCORD_PRESENCE_BUTTON, formatDiscordPresenceDetails } from "@t3tools/contracts";
import { Gamepad2Icon } from "lucide-react";
// Discord shows the production icon uploaded to the shared styal application,
// whatever channel this build is.
import discordIconUrl from "../../../../../assets/prod/black-web-apple-touch-180.png?url";
import { useDiscordPresenceActivity } from "../../hooks/useDiscordPresenceActivity";

const EXAMPLE_ACTIVITY = { activeThreads: 3, activeProjects: 2 };

/**
 * Discord's activity card as other people see it, filled with this client's
 * current counts.
 */
export function DiscordPresencePreview() {
  const activity = useDiscordPresenceActivity();
  const details = formatDiscordPresenceDetails(activity ?? EXAMPLE_ACTIVITY);
  return (
    <div className="mt-3 flex flex-col gap-2 pb-3.5">
      <div
        aria-label={`Discord activity preview: Playing styal, ${details}`}
        className="flex max-w-80 flex-col gap-3 rounded-lg bg-discord-card p-3 text-discord-foreground"
        role="img"
      >
        <div className="text-xs font-semibold">Playing</div>
        <div className="flex items-center gap-3">
          <img
            alt=""
            className="size-16 shrink-0 rounded-lg"
            draggable={false}
            src={discordIconUrl}
          />
          <div className="flex min-w-0 flex-col gap-0.5">
            <div className="truncate text-sm font-semibold">styal</div>
            <div className="truncate text-xs text-discord-muted-foreground">{details}</div>
            <div className="flex items-center gap-1 font-mono text-xs text-discord-elapsed">
              <Gamepad2Icon className="size-3.5" />
              1:23:45
            </div>
          </div>
        </div>
        <div className="rounded-md bg-discord-button py-1.5 text-center text-xs font-medium">
          {DISCORD_PRESENCE_BUTTON.label}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {activity
          ? "Your current counts, with an example time. Discord counts from when styal opened."
          : "Example counts and time. Nothing is shown while no threads are active."}
      </p>
    </div>
  );
}
