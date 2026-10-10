// @effect-diagnostics globalDate:off -- Wall-clock times are resolved against IANA zones through Intl and UTC calendar arithmetic.
/**
 * Times an agent mentions in prose: `14:20 UTC`, `Sunday 17:00`, `2026-09-29T20:30Z`,
 * `49 minutes ago`, `due in about 18 minutes`. Detection is pure text matching; resolution needs
 * the moment the message was written and the time zone of the environment the agent ran in, since
 * that is the clock an agent reads when it writes a time without a zone.
 *
 * Matching is deliberately conservative. Durations ("finished in 36 seconds", "times out after 15
 * seconds") read like times but are not moments, so a forward offset needs a word that makes it
 * one ("due in", "again in"), and a zone-less clock needs a two-digit hour or am/pm to stay clear
 * of elapsed times such as `2:48`.
 */

/**
 * A zone written next to a time: a fixed offset, or a region whose offset depends on the date.
 * `name` is how the text spelled it, for saying which zone a time was read in.
 */
export type MentionedTimeZone =
  | { readonly offsetMinutes: number; readonly name?: string }
  | { readonly timeZone: string; readonly name?: string };

export type MentionedTime =
  | {
      readonly kind: "clock";
      readonly hour: number;
      readonly minute: number;
      readonly second?: number;
      /** A written calendar date; `year` is absent when the text left it out. */
      readonly date?: { readonly year?: number; readonly month: number; readonly day: number };
      /** 0 for Sunday. Only when the text named a weekday without a date. */
      readonly weekday?: number;
      /** `yesterday`, `today`, `tomorrow`. */
      readonly dayOffset?: number;
      readonly zone?: MentionedTimeZone;
      /** The zone was not written next to this time but used throughout the message. */
      readonly zoneFromMessage?: boolean;
      /** Which way the sentence points when the text gives no date: "next at 07:00" is ahead,
          "finished at 22:07" is behind. */
      readonly tense?: "past" | "future";
    }
  | {
      readonly kind: "offset";
      /** Signed distance from when the message was written. */
      readonly milliseconds: number;
    };

export interface MentionedTimeMatch {
  readonly start: number;
  readonly end: number;
  readonly time: MentionedTime;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const MONTHS = [
  "Jan(?:uary)?",
  "Feb(?:ruary)?",
  "Mar(?:ch)?",
  "Apr(?:il)?",
  "May",
  "June?",
  "July?",
  "Aug(?:ust)?",
  "Sept?(?:ember)?",
  "Oct(?:ober)?",
  "Nov(?:ember)?",
  "Dec(?:ember)?",
];
const WEEKDAYS = [
  "Sun(?:day)?",
  "Mon(?:day)?",
  "Tue(?:s(?:day)?)?",
  "Wed(?:nesday)?",
  "Thu(?:rs(?:day)?)?",
  "Fri(?:day)?",
  "Sat(?:urday)?",
];
const MONTH = `(?:${MONTHS.join("|")})`;
const WEEKDAY = `(?:${WEEKDAYS.join("|")})`;
const MONTH_PATTERNS = MONTHS.map((month) => new RegExp(`^${month}$`));
const WEEKDAY_PATTERNS = WEEKDAYS.map((weekday) => new RegExp(`^${weekday}$`));

/**
 * Abbreviations that name one zone in practice. `IST` and `CST` each name several, so they stay
 * unmatched. The North American names follow the region rather than the letter, because people
 * write `EST` all summer; everything else is the fixed offset the abbreviation stands for.
 */
const ZONE_ABBREVIATIONS: Readonly<Record<string, MentionedTimeZone>> = {
  UTC: { offsetMinutes: 0 },
  GMT: { offsetMinutes: 0 },
  Z: { offsetMinutes: 0 },
  WET: { offsetMinutes: 0 },
  WEST: { offsetMinutes: 60 },
  BST: { offsetMinutes: 60 },
  CET: { offsetMinutes: 60 },
  CEST: { offsetMinutes: 120 },
  EET: { offsetMinutes: 120 },
  EEST: { offsetMinutes: 180 },
  MSK: { offsetMinutes: 180 },
  JST: { offsetMinutes: 540 },
  KST: { offsetMinutes: 540 },
  HKT: { offsetMinutes: 480 },
  SGT: { offsetMinutes: 480 },
  AWST: { offsetMinutes: 480 },
  ACST: { offsetMinutes: 570 },
  AEST: { offsetMinutes: 600 },
  AEDT: { offsetMinutes: 660 },
  NZST: { offsetMinutes: 720 },
  NZDT: { offsetMinutes: 780 },
  HST: { offsetMinutes: -600 },
  ET: { timeZone: "America/New_York" },
  EST: { timeZone: "America/New_York" },
  EDT: { timeZone: "America/New_York" },
  CT: { timeZone: "America/Chicago" },
  CDT: { timeZone: "America/Chicago" },
  MT: { timeZone: "America/Denver" },
  MDT: { timeZone: "America/Denver" },
  MST: { offsetMinutes: -420 },
  PT: { timeZone: "America/Los_Angeles" },
  PST: { timeZone: "America/Los_Angeles" },
  PDT: { timeZone: "America/Los_Angeles" },
};
const ZONE_ABBREVIATION = Object.keys(ZONE_ABBREVIATIONS)
  .filter((abbreviation) => abbreviation !== "Z")
  .sort((left, right) => right.length - left.length)
  .join("|");

const DATE =
  `(?:(?<isoYear>\\d{4})-(?<isoMonth>\\d{2})-(?<isoDay>\\d{2})` +
  `|(?:(?<dayMonthWeekday>${WEEKDAY}),?\\s+)?(?<dayMonthDay>\\d{1,2})(?:st|nd|rd|th)?\\s+(?<dayMonthMonth>${MONTH})\\.?(?:,?\\s+(?<dayMonthYear>\\d{4}))?` +
  `|(?:(?<monthDayWeekday>${WEEKDAY}),?\\s+)?(?<monthDayMonth>${MONTH})\\.?\\s+(?<monthDayDay>\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(?<monthDayYear>\\d{4}))?` +
  `|(?<weekday>${WEEKDAY})` +
  `|(?<relativeDay>[Tt]oday|[Tt]onight|[Tt]omorrow|[Yy]esterday))`;
const DATE_SEPARATOR = `(?:,?\\s+at\\s+|,\\s*|\\s+|T)`;
const MERIDIEM = `[AaPp]\\.?[Mm]\\.?`;
const CLOCK =
  `(?:(?<hour>\\d{1,2}):(?<minute>[0-5]\\d)(?::(?<second>[0-5]\\d)(?:\\.\\d+)?)?(?:\\s?(?<meridiem>${MERIDIEM}))?` +
  `|(?<meridiemHour>\\d{1,2})\\s?(?<hourMeridiem>${MERIDIEM}))`;
const ZONE =
  `(?:(?<isoOffset>[+\\-−]\\d{2}:?\\d{2})` +
  `|\\s?(?<utc>UTC|GMT|utc|gmt|Z)(?:\\s?(?<utcOffset>[+\\-−]\\d{1,2}(?::?\\d{2})?))?` +
  `|\\s(?<abbreviation>${ZONE_ABBREVIATION})` +
  `|\\s\\((?<parenthesizedZone>${ZONE_ABBREVIATION})\\)` +
  `|\\s+in\\s+(?<inZone>${ZONE_ABBREVIATION}))`;

const TRAILING_DAY = `(?:,?\\s+(?<trailingDay>today|tonight|tomorrow|yesterday))`;
// A label's colon is punctuation; a colon attached to another token is not a clock boundary.
const CLOCK_PATTERN = new RegExp(
  `(?<![\\w:./#])(?:${DATE}${DATE_SEPARATOR})?${CLOCK}${ZONE}?${TRAILING_DAY}?(?!\\w|:\\S|\\.\\d)`,
  "g",
);

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};
const AMOUNT = `(?:\\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten)`;
// Seconds are left out: by the time anyone reads the message, the moment has passed.
const UNIT = `(?:minutes?|mins?|hours?|hrs?|days?|weeks?)`;
const APPROXIMATELY = `(?:(?:about|around|roughly|approximately|nearly|almost|over|~)\\s*)?`;
const SPAN = `${APPROXIMATELY}(?<amount>${AMOUNT})\\s*(?<unit>${UNIT})(?:,?\\s+(?:and\\s+)?(?<extraAmount>\\d+)\\s*(?<extraUnit>${UNIT}))?`;
// A quoted "5 min ago" is a label being discussed, not a moment.
const AGO_PATTERN = new RegExp(`(?<![\\w"'“‘])${SPAN}\\s+ago\\b(?!["'”’])`, "gi");
/** Words that make the `in …` after them a moment rather than how long something took. */
const FUTURE_CUE =
  "due|scheduled|expires|expiring|resets|resetting|starts|starting|retry|retries|retrying|again|back|ready|fires|firing|ends|ending|closes|opens|lands|landing";
const FUTURE_PATTERN = new RegExp(`(?<=\\b(?:${FUTURE_CUE})\\s+)in\\s+${SPAN}\\b`, "gi");

function unitMilliseconds(unit: string): number {
  const normalized = unit.toLowerCase();
  if (normalized.startsWith("m")) return MINUTE_MS;
  if (normalized.startsWith("h")) return HOUR_MS;
  if (normalized.startsWith("d")) return DAY_MS;
  return 7 * DAY_MS;
}

function amountValue(amount: string): number {
  return NUMBER_WORDS[amount.toLowerCase()] ?? Number(amount);
}

function spanMilliseconds(groups: Record<string, string | undefined>): number | null {
  const { amount, unit, extraAmount, extraUnit } = groups;
  if (amount === undefined || unit === undefined) return null;
  let total = amountValue(amount) * unitMilliseconds(unit);
  if (extraAmount !== undefined && extraUnit !== undefined) {
    total += Number(extraAmount) * unitMilliseconds(extraUnit);
  }
  return Number.isFinite(total) && total > 0 ? total : null;
}

function indexOfPattern(patterns: readonly RegExp[], value: string | undefined): number | null {
  if (value === undefined) return null;
  const index = patterns.findIndex((pattern) => pattern.test(value));
  return index === -1 ? null : index;
}

function parseOffsetMinutes(offset: string): number | null {
  const match = /^([+\-−])(\d{1,2})(?::?(\d{2}))?$/.exec(offset);
  if (!match) return null;
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? 0);
  if (hours > 14 || minutes > 59) return null;
  return (match[1] === "+" ? 1 : -1) * (hours * 60 + minutes);
}

function namedZone(abbreviation: string): MentionedTimeZone | undefined {
  const zone = ZONE_ABBREVIATIONS[abbreviation];
  return zone && { ...zone, name: abbreviation };
}

function zoneKey(zone: MentionedTimeZone): string {
  return "offsetMinutes" in zone ? `offset:${zone.offsetMinutes}` : `region:${zone.timeZone}`;
}

/** How to name a zone a time was read in: as the text spelled it, else its offset or region. */
export function mentionedTimeZoneName(zone: MentionedTimeZone): string {
  if (zone.name !== undefined) return zone.name;
  if ("timeZone" in zone) return zone.timeZone;
  if (zone.offsetMinutes === 0) return "UTC";
  const sign = zone.offsetMinutes > 0 ? "+" : "-";
  const hours = Math.floor(Math.abs(zone.offsetMinutes) / 60);
  const minutes = Math.abs(zone.offsetMinutes) % 60;
  return `UTC${sign}${hours}${minutes === 0 ? "" : `:${String(minutes).padStart(2, "0")}`}`;
}

function parseZone(
  groups: Record<string, string | undefined>,
): MentionedTimeZone | null | undefined {
  if (groups.isoOffset !== undefined) {
    const offsetMinutes = parseOffsetMinutes(groups.isoOffset);
    return offsetMinutes === null ? null : { offsetMinutes };
  }
  if (groups.utc !== undefined) {
    const name = groups.utc.toUpperCase() === "Z" ? "UTC" : groups.utc.toUpperCase();
    if (groups.utcOffset === undefined) return { offsetMinutes: 0, name };
    const offsetMinutes = parseOffsetMinutes(groups.utcOffset);
    return offsetMinutes === null ? null : { offsetMinutes, name: `${name}${groups.utcOffset}` };
  }
  const abbreviation = groups.abbreviation ?? groups.parenthesizedZone ?? groups.inZone;
  if (abbreviation !== undefined) return namedZone(abbreviation);
  return undefined;
}

function parseClock(groups: Record<string, string | undefined>): MentionedTime | null {
  const zone = parseZone(groups);
  if (zone === null) return null;

  const meridiem = (groups.meridiem ?? groups.hourMeridiem)?.toLowerCase().replaceAll(".", "");
  const hourText = groups.hour ?? groups.meridiemHour;
  if (hourText === undefined) return null;
  let hour = Number(hourText);
  const minute = Number(groups.minute ?? 0);
  if (meridiem !== undefined) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem === "pm" ? 12 : 0);
  } else {
    if (hour > 23) return null;
    // `2:48` is far likelier minutes and seconds than a time of day.
    if (hourText.length === 1 && zone === undefined) return null;
  }

  const time: {
    -readonly [Key in keyof Extract<MentionedTime, { kind: "clock" }>]: Extract<
      MentionedTime,
      { kind: "clock" }
    >[Key];
  } = { kind: "clock", hour, minute };
  if (groups.second !== undefined) time.second = Number(groups.second);
  if (zone !== undefined) time.zone = zone;

  if (groups.isoYear !== undefined) {
    time.date = {
      year: Number(groups.isoYear),
      month: Number(groups.isoMonth),
      day: Number(groups.isoDay),
    };
  } else if (groups.dayMonthDay !== undefined || groups.monthDayDay !== undefined) {
    const month = indexOfPattern(MONTH_PATTERNS, groups.dayMonthMonth ?? groups.monthDayMonth);
    if (month === null) return null;
    const year = groups.dayMonthYear ?? groups.monthDayYear;
    time.date = {
      ...(year === undefined ? {} : { year: Number(year) }),
      month: month + 1,
      day: Number(groups.dayMonthDay ?? groups.monthDayDay),
    };
  } else if (groups.weekday !== undefined) {
    const weekday = indexOfPattern(WEEKDAY_PATTERNS, groups.weekday);
    if (weekday === null) return null;
    time.weekday = weekday;
  } else if (groups.relativeDay !== undefined || groups.trailingDay !== undefined) {
    const relativeDay = (groups.relativeDay ?? groups.trailingDay)!.toLowerCase();
    time.dayOffset = relativeDay === "yesterday" ? -1 : relativeDay === "tomorrow" ? 1 : 0;
  }
  if (time.date && (time.date.month < 1 || time.date.month > 12 || time.date.day < 1)) return null;
  if (time.date && time.date.day > 31) return null;
  return time;
}

/** The written zone of a range's end, so `19:32–19:34 BST` reads both ends in BST. */
const RANGE_JOINER = /^\s*(?:–|—|-|to|and|until|till)\s*$/;

/** Words that, nearest before a time in its sentence, say whether it is ahead or behind. */
const TENSE_CUE = new RegExp(
  "(?:\\b(?<future>next|due|expires?|expiring|resets?|resetting|scheduled|will|upcoming)\\b|['’]ll\\b)" +
    "|\\b(?<past>since|was|were|had|did|started|finished|ended|merged|ran|landed|failed|completed|succeeded|published|pushed|created|committed|logged|touched|restarted|exited|went|came|sent|registered|updated|arrived|last|earlier|previously|replied|closed|stopped|crashed|deployed|released)\\b",
  "gi",
);
const TENSE_WINDOW = 80;

function tenseBefore(text: string, start: number, before: string): "past" | "future" | undefined {
  const window = (before + text.slice(0, start)).slice(-TENSE_WINDOW);
  const sentence = window.slice(window.search(/[^.!?\n]*$/));
  let tense: "past" | "future" | undefined;
  for (const match of sentence.matchAll(TENSE_CUE)) {
    tense = match.groups?.future !== undefined ? "future" : "past";
  }
  return tense;
}

/** A zone named in prose, such as a `Time (UTC)` heading or "Times are UTC". */
const ZONE_MENTION = new RegExp(
  `(?:\\(|\\b(?:in|are|is)\\s+)(?<zone>${ZONE_ABBREVIATION})\\b`,
  "g",
);

/**
 * The one zone a message uses, when it writes every zone it names the same way. Agents copy times
 * from logs without repeating the zone each time, so `19:32` beside `19:34 BST` is likelier BST
 * than the agent's own clock.
 */
export function findMessageZone(text: string): MentionedTimeZone | null {
  const zones = new Map<string, MentionedTimeZone>();
  for (const match of findMentionedTimes(text)) {
    if (match.time.kind === "clock" && match.time.zone) {
      zones.set(zoneKey(match.time.zone), match.time.zone);
    }
  }
  for (const match of text.matchAll(ZONE_MENTION)) {
    const zone = match.groups?.zone === undefined ? undefined : namedZone(match.groups.zone);
    if (zone) zones.set(zoneKey(zone), zone);
  }
  return zones.size === 1 ? zones.values().next().value! : null;
}

export interface FindMentionedTimesOptions {
  /** From {@link findMessageZone}; stands in for the zone of times written without one. */
  readonly messageZone?: MentionedTimeZone | null;
  /** Text just before `text` in the same sentence, split off by formatting such as bold. */
  readonly before?: string;
}

/** Every time mentioned in a run of plain text, in order and without overlaps. */
export function findMentionedTimes(
  text: string,
  { messageZone = null, before = "" }: FindMentionedTimesOptions = {},
): MentionedTimeMatch[] {
  const matches: MentionedTimeMatch[] = [];
  for (const match of text.matchAll(CLOCK_PATTERN)) {
    const parsed = match.groups ? parseClock(match.groups) : null;
    if (parsed === null || parsed.kind !== "clock" || match.index === undefined) continue;
    const tense =
      parsed.date || parsed.dayOffset !== undefined
        ? undefined
        : tenseBefore(text, match.index, before);
    const time = tense === undefined ? parsed : { ...parsed, tense };
    matches.push({ start: match.index, end: match.index + match[0].length, time });
  }
  for (const [pattern, sign] of [
    [AGO_PATTERN, -1],
    [FUTURE_PATTERN, 1],
  ] as const) {
    for (const match of text.matchAll(pattern)) {
      const milliseconds = match.groups ? spanMilliseconds(match.groups) : null;
      if (milliseconds === null || match.index === undefined) continue;
      matches.push({
        start: match.index,
        end: match.index + match[0].length,
        time: { kind: "offset", milliseconds: sign * milliseconds },
      });
    }
  }
  matches.sort((left, right) => left.start - right.start);

  const ordered: MentionedTimeMatch[] = [];
  for (const match of matches) {
    const previous = ordered.at(-1);
    if (previous && match.start < previous.end) continue;
    ordered.push(match);
  }

  for (let index = ordered.length - 2; index >= 0; index -= 1) {
    const current = ordered[index]!;
    const next = ordered[index + 1]!;
    if (current.time.kind !== "clock" || next.time.kind !== "clock") continue;
    if (current.time.zone !== undefined || next.time.zone === undefined) continue;
    if (!RANGE_JOINER.test(text.slice(current.end, next.start))) continue;
    ordered[index] = { ...current, time: { ...current.time, zone: next.time.zone } };
  }
  if (messageZone === null) return ordered;
  return ordered.map((match) =>
    match.time.kind === "clock" && match.time.zone === undefined
      ? { ...match, time: { ...match.time, zone: messageZone, zoneFromMessage: true } }
      : match,
  );
}

export interface MentionedTimeAnchor {
  /** When the message was written. Dates the text leaves out are taken relative to it. */
  readonly writtenAtMs: number;
  /** IANA zone of the environment the agent ran in. Without it, zone-less times stay unresolved. */
  readonly environmentTimeZone: string | null;
}

export interface ResolvedMentionedTime {
  readonly instantMs: number;
  /** The text gave no zone, so the environment's zone was assumed. */
  readonly assumedEnvironmentZone: boolean;
  /** The time was read in the zone the rest of the message uses. */
  readonly zoneFromMessage: boolean;
  /** The text gave no date, so the day was chosen from when the message was written. */
  readonly assumedDay: boolean;
  /** The text gave a distance, counted from when the message was written. */
  readonly fromWrittenAt: boolean;
}

interface WallDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

const zoneFormatters = new Map<string, Intl.DateTimeFormat | null>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat | null {
  if (!zoneFormatters.has(timeZone)) {
    let formatter: Intl.DateTimeFormat | null = null;
    try {
      formatter = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
      });
    } catch {
      formatter = null;
    }
    zoneFormatters.set(timeZone, formatter);
  }
  return zoneFormatters.get(timeZone) ?? null;
}

/** The wall clock in `zone` at `instantMs`, expressed as if it were UTC. */
function wallClockAsUtc(instantMs: number, zone: MentionedTimeZone): number | null {
  if ("offsetMinutes" in zone) return instantMs + zone.offsetMinutes * MINUTE_MS;
  const formatter = zoneFormatter(zone.timeZone);
  if (!formatter) return null;
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(instantMs))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return Date.UTC(
    parts.year!,
    parts.month! - 1,
    parts.day!,
    parts.hour!,
    parts.minute!,
    parts.second!,
    instantMs % 1000,
  );
}

function wallDateAt(instantMs: number, zone: MentionedTimeZone): WallDate | null {
  const wall = wallClockAsUtc(instantMs, zone);
  if (wall === null) return null;
  const date = new Date(wall);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function addDays(date: WallDate, days: number): WallDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function weekdayOf(date: WallDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

function isRealDate(date: WallDate): boolean {
  const roundTrip = addDays(date, 0);
  return (
    roundTrip.year === date.year && roundTrip.month === date.month && roundTrip.day === date.day
  );
}

/** The instant a wall-clock time in `zone` names, settling the offset across a DST change. */
function wallTimeToInstant(
  date: WallDate,
  time: Extract<MentionedTime, { kind: "clock" }>,
  zone: MentionedTimeZone,
): number | null {
  const wall = Date.UTC(
    date.year,
    date.month - 1,
    date.day,
    time.hour,
    time.minute,
    time.second ?? 0,
  );
  let instant = wall;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const observed = wallClockAsUtc(instant, zone);
    if (observed === null) return null;
    instant -= observed - wall;
  }
  return instant;
}

/**
 * How far the nearest occurrence must sit on the wrong side of the message before a tense cue
 * overrides it. A cue word can belong to another clause ("the next shutdown should show what hung
 * at 08:50"), so it only settles a time the nearest occurrence would put most of a day away.
 */
const TENSE_OVERRIDE_MS = 3 * HOUR_MS;

/**
 * The occurrence a dateless time means: the nearest to when the message was written, unless the
 * sentence points the other way and the nearest is well on the wrong side of the message.
 */
function chooseOccurrence(
  candidates: readonly (number | null)[],
  writtenAtMs: number,
  tense: "past" | "future" | undefined,
): number | null {
  const known = candidates.filter((candidate) => candidate !== null);
  let nearest: number | null = null;
  for (const candidate of known) {
    if (nearest === null || Math.abs(candidate - writtenAtMs) < Math.abs(nearest - writtenAtMs)) {
      nearest = candidate;
    }
  }
  if (nearest === null) return null;
  if (tense === "future" && nearest < writtenAtMs - TENSE_OVERRIDE_MS) {
    const ahead = known.filter((candidate) => candidate >= writtenAtMs - TENSE_OVERRIDE_MS);
    if (ahead.length > 0) return Math.min(...ahead);
  } else if (tense === "past" && nearest > writtenAtMs + TENSE_OVERRIDE_MS) {
    const behind = known.filter((candidate) => candidate <= writtenAtMs + TENSE_OVERRIDE_MS);
    if (behind.length > 0) return Math.max(...behind);
  }
  return nearest;
}

export function resolveMentionedTime(
  time: MentionedTime,
  anchor: MentionedTimeAnchor,
): ResolvedMentionedTime | null {
  if (time.kind === "offset") {
    return {
      instantMs: anchor.writtenAtMs + time.milliseconds,
      assumedEnvironmentZone: false,
      zoneFromMessage: false,
      assumedDay: false,
      fromWrittenAt: true,
    };
  }

  const zone: MentionedTimeZone | null =
    time.zone ??
    (anchor.environmentTimeZone === null ? null : { timeZone: anchor.environmentTimeZone });
  if (zone === null) return null;
  const writtenDate = wallDateAt(anchor.writtenAtMs, zone);
  if (writtenDate === null) return null;
  const at = (date: WallDate) => (isRealDate(date) ? wallTimeToInstant(date, time, zone) : null);

  let instantMs: number | null;
  let assumedDay = false;
  if (time.date?.year !== undefined) {
    instantMs = at({ year: time.date.year, month: time.date.month, day: time.date.day });
  } else if (time.date) {
    const { month, day } = time.date;
    instantMs = chooseOccurrence(
      [-1, 0, 1].map((years) => at({ year: writtenDate.year + years, month, day })),
      anchor.writtenAtMs,
      time.tense,
    );
  } else if (time.dayOffset !== undefined) {
    instantMs = at(addDays(writtenDate, time.dayOffset));
  } else if (time.weekday !== undefined) {
    const sameWeekday = [-7, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7]
      .map((offset) => addDays(writtenDate, offset))
      .filter((date) => weekdayOf(date) === time.weekday);
    instantMs = chooseOccurrence(sameWeekday.map(at), anchor.writtenAtMs, time.tense);
  } else {
    assumedDay = true;
    instantMs = chooseOccurrence(
      [-1, 0, 1].map((days) => at(addDays(writtenDate, days))),
      anchor.writtenAtMs,
      time.tense,
    );
  }
  if (instantMs === null) return null;
  return {
    instantMs,
    assumedEnvironmentZone: time.zone === undefined,
    zoneFromMessage: time.zoneFromMessage === true,
    assumedDay,
    fromWrittenAt: false,
  };
}
