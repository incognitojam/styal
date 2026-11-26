import type { MentionedTime } from "./mentionedTimePresentation";
const zoneFormatters = new Map<string, Intl.DateTimeFormat>();
const REGIONAL_ZONES: Readonly<Record<string, string>> = {
  ET: "America/New_York",
  EST: "America/New_York",
  EDT: "America/New_York",
  CT: "America/Chicago",
  CDT: "America/Chicago",
  MT: "America/Denver",
  MDT: "America/Denver",
  PT: "America/Los_Angeles",
  PST: "America/Los_Angeles",
  PDT: "America/Los_Angeles",
  "UK TIME": "Europe/London",
  "LONDON TIME": "Europe/London",
  "BRITISH TIME": "Europe/London",
  "PACIFIC TIME": "America/Los_Angeles",
  "MOUNTAIN TIME": "America/Denver",
  "CENTRAL TIME": "America/Chicago",
  "EASTERN TIME": "America/New_York",
};
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const WRITTEN_DATE =
  /(?<!\w)(?<date>\d{4}-\d{2}-\d{2}|(?:today|tonight|tomorrow|yesterday)|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?|\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?(?:,?\s+\d{4})?|(?:Sun(?:day)?|Mon(?:day)?|Tue(?:s(?:day)?)?|Wed(?:nesday)?|Thu(?:rs(?:day)?)?|Fri(?:day)?|Sat(?:urday)?)|the\s+\d{1,2}(?:st|nd|rd|th))(?:,?\s+at\s+|,\s*|\s+)$/i;
const OFFSETS: Readonly<Record<string, number>> = {
  UTC: 0,
  GMT: 0,
  WET: 0,
  WEST: 60,
  EET: 120,
  EEST: 180,
  MSK: 180,
  HKT: 480,
  SGT: 480,
  AWST: 480,
  ACST: 570,
  Z: 0,
  PST: -480,
  PDT: -420,
  MST: -420,
  MDT: -360,
  EST: -300,
  EDT: -240,
  CDT: -300,
  AKST: -540,
  AKDT: -480,
  HST: -600,
  CET: 60,
  CEST: 120,
  BST: 60,
  JST: 540,
  KST: 540,
  AEST: 600,
  AEDT: 660,
  NZST: 720,
  NZDT: 780,
};
const CLOCK =
  /(?<![\w:+-])(?:(\d{4})-(\d{2})-(\d{2})(?:T|\s+(?:at\s+)?))?(\d{1,2})(?::(\d{2})(?::(\d{2}))?)?\s*(a\.?m\.?(?![a-z])|p\.?m\.?(?![a-z]))?\s*((?:UTC|GMT)[+-]\d{1,2}(?::?\d{2})?|[+-]\d{2}:?\d{2}|[A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?|(?:UK|London|British|Pacific|Mountain|Central|Eastern)\s+time|ET|CT|MT|PT|WET|WEST|EET|EEST|MSK|HKT|SGT|AWST|ACST|UTC|GMT|PST|PDT|MST|MDT|EST|EDT|CDT|AKST|AKDT|HST|CET|CEST|BST|JST|KST|AEST|AEDT|NZST|NZDT|Z)(?![\w/+-])/gi;

export function mentionedTimes(text: string, reference: Date, precedingText = "") {
  const matches: {
    start: number;
    end: number;
    text: string;
    instant: number;
    assumedDate: boolean;
    time: MentionedTime;
    chipEnd: number;
  }[] = [];
  for (const match of text.matchAll(CLOCK)) {
    const [, year, month, day, hour, minute, second, period, zone] = match;
    if (!minute && !period) continue;
    let h = Number(hour);
    const m = Number(minute ?? 0),
      s = Number(second ?? 0);
    if (m > 59 || s > 59 || h > (period ? 12 : 23) || (period && h < 1)) continue;
    if (period) h = (h % 12) + (period.toLowerCase().replaceAll(".", "") === "pm" ? 12 : 0);
    const upper = zone!.toUpperCase();
    const offset = /^(?:UTC|GMT)?([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(upper);
    const region = REGIONAL_ZONES[upper];
    let minutes = region ? undefined : OFFSETS[upper];
    if (offset) {
      if (
        Number(offset[2]) > 14 ||
        Number(offset[3] ?? 0) > 59 ||
        (Number(offset[2]) === 14 && Number(offset[3] ?? 0) > 0)
      )
        continue;
      minutes = (Number(offset[2]) * 60 + Number(offset[3] ?? 0)) * (offset[1] === "+" ? 1 : -1);
    }
    let formatter: Intl.DateTimeFormat | undefined;
    if (minutes === undefined) {
      try {
        const timeZone = region ?? zone!;
        formatter =
          zoneFormatters.get(timeZone) ??
          new Intl.DateTimeFormat("en-CA", {
            timeZone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hourCycle: "h23",
          });
        zoneFormatters.set(timeZone, formatter);
      } catch {
        continue;
      }
    }
    const parts = (date: Date) =>
      Object.fromEntries(formatter!.formatToParts(date).map((p) => [p.type, p.value]));
    const anchor = minutes === undefined ? parts(reference) : null;
    const clockDate = new Date(reference.getTime() + (minutes ?? 0) * 60_000);
    let y = Number(year ?? anchor?.year ?? clockDate.getUTCFullYear());
    let mo = Number(month ?? anchor?.month ?? clockDate.getUTCMonth() + 1);
    let d = Number(day ?? anchor?.day ?? clockDate.getUTCDate());
    let start = match.index;
    let end = match.index + match[0].length;
    const before = year ? null : WRITTEN_DATE.exec(precedingText + text.slice(0, start));
    const trailing =
      year || before ? null : /^\s+(today|tonight|tomorrow|yesterday)\b/i.exec(text.slice(end));
    const writtenDate = before?.groups?.date ?? trailing?.[1];
    if (before) start = Math.max(0, before.index - precedingText.length);
    if (trailing) end += trailing[0].length;
    if (writtenDate) {
      const lower = writtenDate.toLowerCase();
      const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(lower);
      const weekday = WEEKDAYS.indexOf(lower.slice(0, 3));
      const ordinal = /^the\s+(\d+)/.exec(lower);
      if (iso) {
        y = Number(iso[1]);
        mo = Number(iso[2]);
        d = Number(iso[3]);
      } else if (/^(today|tonight|tomorrow|yesterday)$/.test(lower)) {
        d += lower === "tomorrow" ? 1 : lower === "yesterday" ? -1 : 0;
        const shifted = new Date(Date.UTC(y, mo - 1, d));
        y = shifted.getUTCFullYear();
        mo = shifted.getUTCMonth() + 1;
        d = shifted.getUTCDate();
      } else if (weekday >= 0) {
        const current = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
        let shift = (weekday - current + 7) % 7;
        if (shift > 3) shift -= 7;
        const shifted = new Date(Date.UTC(y, mo - 1, d + shift));
        y = shifted.getUTCFullYear();
        mo = shifted.getUTCMonth() + 1;
        d = shifted.getUTCDate();
      } else if (ordinal) d = Number(ordinal[1]);
      else {
        const words = lower.match(/[a-z]+|\d+/g)!;
        const namedMonth = words.find((word) => MONTHS.includes(word.slice(0, 3)))!;
        mo = MONTHS.indexOf(namedMonth.slice(0, 3)) + 1;
        const numbers = words.filter((word) => /^\d+$/.test(word));
        d = Number(numbers[0]);
        if (numbers[1]) y = Number(numbers[1]);
      }
    }
    const wall = Date.UTC(y, mo - 1, d, h, m, s);
    const check = new Date(wall);
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d)
      continue;
    const assumedDate = !year && !writtenDate;
    let instant: number | undefined;
    for (const shift of assumedDate ? [-86_400_000, 0, 86_400_000] : [0]) {
      const target = wall + shift;
      let candidate = target - (minutes ?? 0) * 60_000;
      if (formatter) {
        let shown = 0;
        // Resolve the offset at the candidate date and reject nonexistent DST wall times.
        for (let i = 0; i < 4; i++) {
          const p = parts(new Date(candidate));
          shown = Date.UTC(
            Number(p.year),
            Number(p.month) - 1,
            Number(p.day),
            Number(p.hour),
            Number(p.minute),
            Number(p.second),
          );
          if (shown === target) break;
          if (i < 3) candidate += target - shown;
        }
        if (shown !== target) continue;
      }
      if (
        instant === undefined ||
        Math.abs(candidate - reference.getTime()) < Math.abs(instant - reference.getTime())
      )
        instant = candidate;
    }
    if (instant === undefined) continue;
    matches.push({
      start,
      end,
      text: text.slice(start, end),
      assumedDate,
      chipEnd: zone!.includes("/")
        ? match.index + match[0].slice(0, match[0].lastIndexOf(zone!)).trimEnd().length
        : end,
      time: {
        kind: "clock",
        hour: h,
        minute: m,
        ...(second === undefined ? {} : { second: s }),
        ...(!assumedDate ? { date: { year: y, month: mo, day: d } } : {}),
        ...(/^(today|tonight|tomorrow|yesterday)$/i.test(writtenDate ?? "")
          ? {
              dayOffset: /tomorrow/i.test(writtenDate!)
                ? 1
                : /yesterday/i.test(writtenDate!)
                  ? -1
                  : 0,
            }
          : {}),
        zone:
          minutes === undefined
            ? { timeZone: region ?? zone!, name: zone! }
            : { offsetMinutes: minutes, name: zone! },
      },
      instant,
    });
  }
  return matches;
}
