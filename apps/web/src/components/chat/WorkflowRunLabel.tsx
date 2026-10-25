import { formatWorkflowRunDisplayName } from "@t3tools/client-runtime/state/workflow-run-display";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function WorkflowRunLabel({ name }: { readonly name: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span tabIndex={0} aria-label={name} className="min-w-0 truncate" />}>
        {formatWorkflowRunDisplayName(name)}
      </TooltipTrigger>
      <TooltipPopup side="top">{name}</TooltipPopup>
    </Tooltip>
  );
}
