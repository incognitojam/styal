import { NotificationSettings as ThreadNotificationSettings } from "./NotificationSettings";
import { useGT } from "gt-react";
import { useOutagePreferences } from "../../outagePreferences";
import { StyalToolIcon } from "../StyalToolIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";

function OutageSettings() {
  const gt = useGT();
  const [enabled, setEnabled] = useOutagePreferences();
  return (
    <SettingsRow
      title={
        <span className="flex items-center gap-1.5">
          {gt("Outage alerts")}
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  tabIndex={0}
                  aria-label={gt("styal feature")}
                  className="inline-flex h-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground/70 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                />
              }
            >
              <StyalToolIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">{gt("Only in styal")}</TooltipPopup>
          </Tooltip>
        </span>
      }
      description={gt(
        "Shows affected services in the sidebar during incidents, based on each service's official status page.",
      )}
    >
      <div className="mt-2 mb-2 border-l border-border/60 pl-3 sm:pl-4">
        {["Claude", "OpenAI", "GitHub"].map((name) => (
          <div
            key={name}
            className={`flex flex-wrap justify-between gap-x-8 gap-y-2 rounded-md py-1.5 ${name === "GitHub" ? "items-start" : "items-center"}`}
          >
            <div className="min-w-0">
              <div className="flex min-h-5 items-center gap-1.5">
                <h4 className="text-sm text-foreground/90">{name}</h4>
                <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center" />
              </div>
              {name === "GitHub" ? (
                <p className="text-xs leading-normal text-muted-foreground/80">
                  {gt("Shown while you have a GitHub project.")}
                </p>
              ) : null}
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <Switch
                aria-label={gt("Enable {name} outage alerts", { name })}
                checked={enabled[name] !== false}
                onCheckedChange={(checked) => setEnabled({ ...enabled, [name]: checked })}
              />
            </div>
          </div>
        ))}
      </div>
    </SettingsRow>
  );
}

export function NotificationSettings() {
  return (
    <>
      <ThreadNotificationSettings />
      <OutageSettings />
    </>
  );
}
