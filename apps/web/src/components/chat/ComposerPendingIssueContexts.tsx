import { CircleDot, X } from "lucide-react";

import { ContextChip, ContextChipAction, ContextChipLabel } from "../ContextChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { type IssueContextDraft, formatIssueContextLabel } from "~/lib/issueContext";

interface ComposerPendingIssueContextsProps {
  contexts: ReadonlyArray<IssueContextDraft>;
  onRemove: (contextId: string) => void;
  className?: string;
}

interface ComposerPendingIssueContextChipProps {
  context: IssueContextDraft;
  onRemove: (contextId: string) => void;
}

function buildTooltipContent(context: IssueContextDraft): string {
  const lines: string[] = [];
  lines.push(formatIssueContextLabel(context));
  if (context.repository) lines.push(context.repository);
  if (context.author) lines.push(`opened by ${context.author}`);
  if (context.comments.length > 0) {
    lines.push(`${context.comments.length} comment${context.comments.length === 1 ? "" : "s"}`);
  }
  const body = context.body.trim();
  if (body.length > 0) {
    lines.push("");
    lines.push(body.slice(0, 600));
  }
  return lines.join("\n");
}

function ComposerPendingIssueContextChip({
  context,
  onRemove,
}: ComposerPendingIssueContextChipProps) {
  const label = formatIssueContextLabel(context);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ContextChip>
            <CircleDot />
            <ContextChipLabel>{label}</ContextChipLabel>
            <ContextChipAction
              aria-label={`Remove ${label}`}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onRemove(context.id);
              }}
            >
              <X aria-hidden />
            </ContextChipAction>
          </ContextChip>
        }
      />
      <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap">
        {buildTooltipContent(context)}
      </TooltipPopup>
    </Tooltip>
  );
}

export function ComposerPendingIssueContexts({
  contexts,
  onRemove,
  className,
}: ComposerPendingIssueContextsProps) {
  if (contexts.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {contexts.map((context) => (
        <ComposerPendingIssueContextChip key={context.id} context={context} onRemove={onRemove} />
      ))}
    </div>
  );
}
