import { msg } from "gt-react";
import { m, type MessageResolver } from "../../i18n/messages";
import {
  type MentionedTime,
  type MentionedTimeAnchor,
  mentionedTimeZoneName,
  type ResolvedMentionedTime,
} from "./mentionedTimePresentation";

import type { TimestampFormat } from "@t3tools/contracts/settings";

import {
  formatMentionedDayLabel,
  formatMentionedTimeLabel,
  formatRelativeToNow,
} from "./mentionedTimeFormat";

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
    readonly nowMs?: number;
    readonly resolve?: MessageResolver;
    readonly locale?: string;
  },
): MentionedTimeDetails {
  const nowMs = options.nowMs ?? Date.now();
  const resolve = options.resolve ?? m;
  const includeSeconds = time.second !== undefined;
  const label = formatMentionedTimeLabel(
    resolved.instantMs,
    options.timestampFormat,
    includeSeconds,
    nowMs,
    resolve,
    options.locale,
  );
  const local = new Date(resolved.instantMs);
  const timeChanged = local.getHours() !== time.hour || local.getMinutes() !== time.minute;
  const dayStated = time.date !== undefined || time.dayOffset !== undefined;
  const day = formatMentionedDayLabel(resolved.instantMs, nowMs, resolve, options.locale);
  const detail = timeChanged ? label : dayStated || day === resolve(msg("Today")) ? null : day;

  const convertedFrom = timeChanged ? mentionedTimeZoneName(time.zone) : null;
  const assumedDate =
    resolved.assumedDay &&
    readerDayFormatter.format(resolved.instantMs) !== readerDayFormatter.format(anchor.writtenAtMs);
  let note: string | null = null;
  if (convertedFrom !== null)
    note = assumedDate
      ? resolve(msg("Converted from {zone}, assumed date"), { zone: convertedFrom })
      : resolve(msg("Converted from {zone}"), { zone: convertedFrom });
  else if (assumedDate) note = resolve(msg("Assumed date"));
  // "yesterday" in the text already says what a day-scale relative time would.
  if (time.dayOffset !== undefined && Math.abs(resolved.instantMs - nowMs) >= 86_400_000) {
    return { lead: timeChanged ? label : day, detail: null, note };
  }
  return { lead: formatRelativeToNow(resolved.instantMs, nowMs, options.locale), detail, note };
}
