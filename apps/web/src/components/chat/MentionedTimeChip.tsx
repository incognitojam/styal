import {
  type MentionedTime,
  type MentionedTimeAnchor,
  mentionedTimeZoneName,
  resolveMentionedTime,
  type ResolvedMentionedTime,
} from "@t3tools/client-runtime/mentioned-times";
import { type ReactNode, useMemo } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { formatMentionedTimeLabel, formatRelativeToNow } from "../../timestampFormat";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const READER_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

const readerDayFormatter = new Intl.DateTimeFormat("en-CA", { dateStyle: "short" });

/** The inferred day only needs pointing out when it is not the day the message was sent. */
function isSameReaderDay(leftMs: number, rightMs: number): boolean {
  return readerDayFormatter.format(leftMs) === readerDayFormatter.format(rightMs);
}

/**
 * A time an agent wrote, kept as written and marked so hovering it says when that is for the
 * reader. Text that cannot be pinned to a moment, such as a zone-less time from a server that does
 * not report its zone, renders as plain text.
 */
export function MentionedTimeChip(props: {
  time: MentionedTime;
  anchor: MentionedTimeAnchor;
  children: ReactNode;
}) {
  const { time, anchor } = props;
  const resolved = useMemo(() => resolveMentionedTime(time, anchor), [time, anchor]);
  if (resolved === null) return props.children;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="cursor-default rounded-[4px] bg-foreground/[0.06] px-[3px] box-decoration-clone hover:bg-foreground/10" />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="top">
        <MentionedTimeDetails
          instantMs={resolved.instantMs}
          includeSeconds={time.kind === "clock" && time.second !== undefined}
          note={assumptionNote(time, anchor, resolved)}
        />
      </TooltipPopup>
    </Tooltip>
  );
}

/** One short line saying what the tooltip had to assume, or nothing when it assumed nothing. */
function assumptionNote(
  time: MentionedTime,
  anchor: MentionedTimeAnchor,
  resolved: ResolvedMentionedTime,
): string | null {
  if (resolved.fromWrittenAt) return "Counted from when sent";
  let zone: string | null = null;
  if (resolved.zoneFromMessage && time.kind === "clock" && time.zone) {
    zone = mentionedTimeZoneName(time.zone);
  } else if (resolved.assumedEnvironmentZone && anchor.environmentTimeZone !== READER_TIME_ZONE) {
    zone = anchor.environmentTimeZone;
  }
  const date = resolved.assumedDay && !isSameReaderDay(resolved.instantMs, anchor.writtenAtMs);
  if (zone !== null) return date ? `Assumed ${zone} and date` : `Assumed ${zone}`;
  return date ? "Assumed date" : null;
}

/** Mounted only while the tooltip is open, so "in 3 hours" is computed then and never ticks. */
function MentionedTimeDetails(props: {
  instantMs: number;
  includeSeconds: boolean;
  note: string | null;
}) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  return (
    <div className="flex flex-col gap-0.5">
      <span>
        <span className="font-medium">
          {formatMentionedTimeLabel(props.instantMs, timestampFormat, props.includeSeconds)}
        </span>
        <span className="text-muted-foreground"> · {formatRelativeToNow(props.instantMs)}</span>
      </span>
      {props.note === null ? null : (
        <span className="text-muted-foreground text-xs">{props.note}</span>
      )}
    </div>
  );
}
