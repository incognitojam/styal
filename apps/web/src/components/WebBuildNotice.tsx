import { useEffect, useSyncExternalStore } from "react";
import { useGT } from "gt-react";
import { RotateCwIcon } from "lucide-react";
import { isElectron } from "../env";
import { watchWebBuildUpdates } from "../webBuildUpdate";
import { SidebarMenuItem } from "./ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

let available = false;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = () => available;

export function WebBuildWatcher() {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- watches the served build and publishes availability to the sidebar's external store
  useEffect(() => {
    if (import.meta.env.DEV || isElectron) return;
    return watchWebBuildUpdates(import.meta.env.APP_BUILD_ID, (build) => {
      const next = build !== null;
      if (next === available) return;
      available = next;
      for (const listener of listeners) listener();
    });
  }, []);
  return null;
}

export function WebBuildNotice() {
  const gt = useGT();
  const changed = useSyncExternalStore(subscribe, snapshot, snapshot);
  if (!changed) return null;
  return (
    <SidebarMenuItem className="ml-auto shrink-0 [[data-sidebar-update]+&]:ml-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="inline-flex size-8 cursor-pointer items-center justify-center rounded-full bg-update-surface text-update-foreground outline-hidden ring-ring transition-colors hover:bg-update-surface-hover focus-visible:ring-2 focus-visible:ring-inset"
              aria-label={gt("New build available. Refresh")}
              onClick={() => window.location.reload()}
            />
          }
        >
          <RotateCwIcon className="size-4" />
        </TooltipTrigger>
        <TooltipPopup side="top" variant="glass">
          {gt("New build available. Refresh")}
        </TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}
