import { msg } from "gt-react";
import { getActiveLocale, m, type MessageResolver } from "../../i18n/messages";
import type { TimestampFormat } from "@t3tools/contracts/settings";

/** The day of an instant as the reader says it: `Today`, `Yesterday`, `Sun, Nov 1`. */
export function formatMentionedDayLabel(
  instantMs: number,
  nowMs: number = Date.now(),
  resolve: MessageResolver = m,
  locale = getActiveLocale(),
): string {
  const date = new Date(instantMs);
  const now = new Date(nowMs);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  // Round so DST-shifted 23/25 hour days still count as whole days.
  const dayDiff = Math.round((startOfDay - startOfToday) / 86_400_000);
  if (dayDiff === 0) return resolve(msg("Today"));
  if (dayDiff === 1) return resolve(msg("Tomorrow"));
  if (dayDiff === -1) return resolve(msg("Yesterday"));
  return new Intl.DateTimeFormat(
    locale,
    date.getFullYear() === now.getFullYear()
      ? { weekday: "short", day: "numeric", month: "short" }
      : { day: "numeric", month: "short", year: "numeric" },
  ).format(date);
}

export function formatMentionedTimeLabel(
  instantMs: number,
  timestampFormat: TimestampFormat,
  includeSeconds: boolean,
  nowMs: number = Date.now(),
  resolve: MessageResolver = m,
  locale = getActiveLocale(),
): string {
  const date = new Date(instantMs);
  const time = new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
    ...(includeSeconds ? { second: "2-digit" } : {}),
    ...(timestampFormat === "locale" ? {} : { hour12: timestampFormat === "12-hour" }),
  }).format(date);
  const now = new Date(nowMs);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  // Round so DST-shifted 23/25 hour days still count as whole days.
  const dayDiff = Math.round((startOfDay - startOfToday) / 86_400_000);

  if (dayDiff === 0) return resolve(msg("Today at {time}"), { time });
  if (dayDiff === 1) return resolve(msg("Tomorrow at {time}"), { time });
  if (dayDiff === -1) return resolve(msg("Yesterday at {time}"), { time });
  return `${formatMentionedDayLabel(instantMs, nowMs, resolve, locale)}, ${time}`;
}

const RELATIVE_UNITS: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 86_400_000],
  ["month", 30 * 86_400_000],
  ["week", 7 * 86_400_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

/** How far an instant is from now in its largest whole unit: `in 3 hours`, `49 minutes ago`. */
export function formatRelativeToNow(
  instantMs: number,
  nowMs: number = Date.now(),
  locale = getActiveLocale(),
): string {
  const relativeTimeFormatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const diffMs = instantMs - nowMs;
  for (const [unit, unitMs] of RELATIVE_UNITS) {
    if (Math.abs(diffMs) >= unitMs) {
      return relativeTimeFormatter.format(Math.trunc(diffMs / unitMs), unit);
    }
  }
  return relativeTimeFormatter.format(0, "second");
}
