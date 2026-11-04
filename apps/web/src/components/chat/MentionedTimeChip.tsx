import {
  type MentionedTime,
  type MentionedTimeAnchor,
  resolveMentionedTime,
  type ResolvedMentionedTime,
} from "@t3tools/client-runtime/mentioned-times";
import { type ReactNode, useRef } from "react";
import type { EnvironmentId } from "@t3tools/contracts";

import { reportForkClientUsage } from "../../forkClientUsage";
import { useClientSettings } from "../../hooks/useSettings";
import { describeMentionedTime } from "./mentionedTimeDetails";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const READER_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * A time an agent wrote, kept as written and marked so hovering it says when that is for the
 * reader. Text that cannot be pinned to a moment, such as a zone-less time from a server that does
 * not report its zone, renders as plain text.
 */
export function MentionedTimeChip(props: {
  environmentId: EnvironmentId | null;
  time: MentionedTime;
  anchor: MentionedTimeAnchor;
  children: ReactNode;
}) {
  const { time, anchor } = props;
  const resolved = resolveMentionedTime(time, anchor);
  const reported = useRef(false);
  if (resolved === null) return props.children;
  return (
    <Tooltip
      onOpenChange={(open, details) => {
        if (open && !details.isCanceled && !reported.current) {
          const pending = reportForkClientUsage(props.environmentId, {
            feature: "mentioned-time-chips",
            action: "details_opened",
          });
          // Unsupported servers leave the chip eligible if support arrives later.
          if (pending) reported.current = true;
        }
      }}
    >
      <TooltipTrigger
        render={
          <span className="cursor-default rounded-sm bg-foreground/[0.06] px-0.75 box-decoration-clone hover:bg-foreground/10" />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="top">
        <MentionedTimeDetails time={time} anchor={anchor} resolved={resolved} />
      </TooltipPopup>
    </Tooltip>
  );
}

/** Mounted only while the tooltip is open, so "in 3 hours" is computed then and never ticks. */
function MentionedTimeDetails(props: {
  time: MentionedTime;
  anchor: MentionedTimeAnchor;
  resolved: ResolvedMentionedTime;
}) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const { lead, detail, note } = describeMentionedTime(props.time, props.anchor, props.resolved, {
    timestampFormat,
    readerTimeZone: READER_TIME_ZONE,
  });
  return (
    <div className="flex flex-col gap-0.5">
      <span>
        <span className="font-medium">{lead}</span>
        {detail === null ? null : <span className="text-muted-foreground"> · {detail}</span>}
      </span>
      {note === null ? null : <span className="text-muted-foreground text-xs">{note}</span>}
    </div>
  );
}
