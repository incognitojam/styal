import {
  type MentionedTime,
  type MentionedTimeAnchor,
  mentionedTimeZoneName,
  type ResolvedMentionedTime,
} from "@t3tools/client-runtime/mentioned-times";

import type { TimestampFormat } from "@t3tools/contracts/settings";

import {
  formatMentionedDayLabel,
  formatMentionedTimeLabel,
  formatRelativeToNow,
} from "../../timestampFormat";

export interface MentionedTimeDetails {
  /** What the chip's text cannot say: how far away the moment is, or when an offset lands. */
  readonly lead: string;
  /** The day, or the time in the reader's zone, when the text left it out or wrote another zone. */
  readonly detail: string | null;
  /** What the explanation had to assume or convert. */
  readonly note: string | null;
}

const readerDayFormatter = new Intl.DateTimeFormat("en-CA", { dateStyle: "short" });

/**
 * The explanation for a mentioned time, without repeating what the chip already shows: a time
 * written in the reader's zone on a stated day needs only how far away it is.
 */
export function describeMentionedTime(
  time: MentionedTime,
  anchor: MentionedTimeAnchor,
  resolved: ResolvedMentionedTime,
  options: {
    readonly timestampFormat: TimestampFormat;
    readonly readerTimeZone: string;
    readonly nowMs?: number;
  },
): MentionedTimeDetails {
  const nowMs = options.nowMs ?? Date.now();
  const includeSeconds = time.kind === "clock" && time.second !== undefined;
  const label = formatMentionedTimeLabel(
    resolved.instantMs,
    options.timestampFormat,
    includeSeconds,
    nowMs,
  );
  if (time.kind === "offset") {
    return { lead: label, detail: null, note: "Counted from when sent" };
  }

  const local = new Date(resolved.instantMs);
  const timeChanged = local.getHours() !== time.hour || local.getMinutes() !== time.minute;
  // A day the model read from the story is news to someone looking at the time alone.
  const dayStated =
    (time.date !== undefined && time.dateFromCheck !== true) ||
    time.dayOffset !== undefined ||
    time.weekday !== undefined;
  const day = formatMentionedDayLabel(resolved.instantMs, nowMs);
  const detail = timeChanged ? label : dayStated || day === "Today" ? null : day;

  let assumedZone: string | null = null;
  let convertedFrom: string | null = null;
  if (resolved.zoneFromMessage && time.zone) {
    assumedZone = mentionedTimeZoneName(time.zone);
  } else if (
    resolved.assumedEnvironmentZone &&
    anchor.environmentTimeZone !== options.readerTimeZone
  ) {
    assumedZone = anchor.environmentTimeZone;
  } else if (timeChanged && time.zone) {
    convertedFrom = mentionedTimeZoneName(time.zone);
  }
  const assumedDate =
    resolved.assumedDay &&
    readerDayFormatter.format(resolved.instantMs) !== readerDayFormatter.format(anchor.writtenAtMs);
  let note: string | null = null;
  if (assumedZone !== null)
    note = assumedDate ? `Assumed ${assumedZone} and date` : `Assumed ${assumedZone}`;
  else if (convertedFrom !== null)
    note = assumedDate
      ? `Converted from ${convertedFrom}, assumed date`
      : `Converted from ${convertedFrom}`;
  else if (assumedDate) note = "Assumed date";
  if (time.dateFromCheck === true) {
    note = note === null ? "Day from the reply" : `${note}, day from the reply`;
  }
  // "yesterday" in the text already says what a day-scale relative time would.
  if (time.dayOffset !== undefined && Math.abs(resolved.instantMs - nowMs) >= 86_400_000) {
    return { lead: timeChanged ? label : day, detail: null, note };
  }
  return { lead: formatRelativeToNow(resolved.instantMs, nowMs), detail, note };
}
