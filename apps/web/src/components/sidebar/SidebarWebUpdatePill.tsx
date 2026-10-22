import { RotateCwIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import { useWebBuildUpdate } from "../WebBuildUpdateProvider";
import { observeWebBuildUpdateNotice } from "../../webBuildUpdateUsage";
import { SidebarMenuItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function SidebarWebUpdatePill() {
  const { available, noticeShown, refresh } = useWebBuildUpdate();
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (available && trigger.current) {
      return observeWebBuildUpdateNotice(trigger.current, noticeShown);
    }
  }, [available, noticeShown]);
  if (!available) return null;

  return (
    <SidebarMenuItem className="ml-auto shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              ref={trigger}
              aria-label="New build available. Refresh"
              className="inline-flex size-8 cursor-pointer items-center justify-center rounded-full bg-update-surface text-update-foreground outline-hidden ring-ring transition-colors hover:bg-update-surface-hover focus-visible:ring-2 focus-visible:ring-inset"
              onClick={refresh}
            />
          }
        >
          <RotateCwIcon className="size-4" />
        </TooltipTrigger>
        <TooltipPopup side="top" variant="glass">
          New build available. Refresh
        </TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}
