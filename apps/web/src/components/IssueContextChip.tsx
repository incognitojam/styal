import type { IssueContextRecord } from "@t3tools/contracts";
import { CircleDot } from "lucide-react";

import { ContextChip, ContextChipLabel } from "./ContextChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

function issueTooltip(record: IssueContextRecord): string {
  const lines = [`#${record.number} ${record.title}`];
  if (record.repository) lines.push(record.repository);
  if (record.author) lines.push(`opened by ${record.author}`);
  if (record.comments.length > 0) {
    lines.push(`${record.comments.length} comment${record.comments.length === 1 ? "" : "s"}`);
  }
  const body = record.body.trim();
  if (body.length > 0) lines.push("", body.slice(0, 600));
  return lines.join("\n");
}

/** Inline chip for an attached issue, in the composer and in sent messages. */
export function IssueContextChip(props: { record: IssueContextRecord; copyMarkdown?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ContextChip
            aria-label={`Issue, ${props.record.label}`}
            data-markdown-copy={props.copyMarkdown}
          >
            <CircleDot />
            <ContextChipLabel>{props.record.label}</ContextChipLabel>
          </ContextChip>
        }
      />
      <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap">
        {issueTooltip(props.record)}
      </TooltipPopup>
    </Tooltip>
  );
}
