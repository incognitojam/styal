import { CircleDot, X } from "lucide-react";

import {
  COMPOSER_INLINE_CHIP_CLASS_NAME,
  COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
} from "../composerInlineChip";
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

export function ComposerPendingIssueContextChip({
  context,
  onRemove,
}: ComposerPendingIssueContextChipProps) {
  const label = formatIssueContextLabel(context);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className={cn(COMPOSER_INLINE_CHIP_CLASS_NAME, "pr-1")}>
            <CircleDot className={cn(COMPOSER_INLINE_CHIP_ICON_CLASS_NAME, "size-3.5")} />
            <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>{label}</span>
            <button
              type="button"
              aria-label={`Remove ${label}`}
              className={COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onRemove(context.id);
              }}
            >
              <X className="size-3" aria-hidden />
            </button>
          </span>
        }
      />
      <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap leading-tight">
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
