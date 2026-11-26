import { describeMentionedTime } from "./mentionedTimeDetails";
import { describe, expect, it } from "vite-plus/test";
import { mentionedTimes } from "./mentionedTimes";
const anchor = new Date("2026-06-15T12:00:00Z");
describe("explicit-zone times", () => {
  it("converts clocks, offsets, dates and regional daylight time", () => {
    for (const [text, iso] of [
      ["at 9:30 am UTC", "2026-06-15T09:30:00Z"],
      ["at 14:00 UTC+05:30", "2026-06-15T08:30:00Z"],
      ["2026-01-02T23:45-04:00", "2026-01-03T03:45:00Z"],
      ["at 10:00 America/New_York", "2026-06-15T14:00:00Z"],
      ["at 2 pm America/New_York", "2026-06-15T18:00:00Z"],
      ["2026-01-02 2 pm America/New_York", "2026-01-02T19:00:00Z"],
    ])
      expect(mentionedTimes(text!, anchor)[0]?.instant).toBe(Date.parse(iso!));
  });
  it("honors written calendar and relative dates and seasonal named zones", () => {
    for (const [text, iso] of [
      ["2026-06-16 at 10:00 UTC", "2026-06-16T10:00:00Z"],
      ["Tomorrow at 10:00 UTC", "2026-06-16T10:00:00Z"],
      ["November 27, 2026 at 10:00 UTC", "2026-11-27T10:00:00Z"],
      ["27 November 2026 at 10:00 UTC", "2026-11-27T10:00:00Z"],
      ["Tuesday at 10:00 UTC", "2026-06-16T10:00:00Z"],
      ["10:00 UTC tomorrow", "2026-06-16T10:00:00Z"],
      ["at 10:00 PT", "2026-06-15T17:00:00Z"],
      ["at 10:00 EST", "2026-06-15T14:00:00Z"],
      ["at 10:00 UK time", "2026-06-15T09:00:00Z"],
    ])
      expect(mentionedTimes(text!, anchor)[0]?.instant).toBe(Date.parse(iso!));
    expect(mentionedTimes("Tomorrow at 10:00 UTC", anchor)[0]?.assumedDate).toBe(false);
    expect(mentionedTimes("10:00 UTC", anchor)[0]?.assumedDate).toBe(true);
  });
  it("honors date context split from the clock by inline formatting", () => {
    expect(mentionedTimes("10:00 UTC", anchor, "Tomorrow at ")[0]).toMatchObject({
      text: "10:00 UTC",
      start: 0,
      instant: Date.parse("2026-06-16T10:00:00Z"),
      assumedDate: false,
    });
  });
  it("skips zone-less, ambiguous, invalid and nonexistent wall times", () => {
    for (const text of [
      "14:00",
      "2 pm",
      "14:00 CST",
      "14:00 IST",
      "29:00 UTC",
      "12:70 UTC",
      "2026-02-30T12:00Z",
      "14:00 UTC+15:00",
      "2026-03-08 02:30 America/New_York",
    ])
      expect(mentionedTimes(text, anchor)).toEqual([]);
  });
});

it("chooses the nearest day when written zones are on opposite sides of midnight", () => {
  const written = new Date("2026-11-26T02:45:00Z");
  expect(mentionedTimes("9:30 am America/New_York", written)[0]?.instant).toBe(
    Date.parse("2026-11-26T14:30:00Z"),
  );
  expect(mentionedTimes("23:30 UTC", written)[0]?.instant).toBe(Date.parse("2026-11-25T23:30:00Z"));
  expect(mentionedTimes("2026-11-25 9:30 am America/New_York", written)[0]?.instant).toBe(
    Date.parse("2026-11-25T14:30:00Z"),
  );
});

it("keeps the tooltip relative and adds only useful conversion or date details", () => {
  const written = new Date(2026, 10, 26, 4);
  const offset = -written.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const zone = `UTC${sign}${Math.floor(Math.abs(offset) / 60)}:${String(Math.abs(offset) % 60).padStart(2, "0")}`;
  const match = mentionedTimes(`14:00 ${zone}`, written)[0]!;
  const details = describeMentionedTime(
    match.time,
    { writtenAtMs: written.getTime() },
    {
      instantMs: match.instant,
      assumedDay: match.assumedDate,
    },
    {
      timestampFormat: "24-hour",
      nowMs: written.getTime(),
    },
  );
  expect(details).toEqual({ lead: "in 10 hours", detail: null, note: null });
  expect(
    describeMentionedTime(
      match.time,
      { writtenAtMs: written.getTime() },
      { instantMs: match.instant, assumedDay: match.assumedDate },
      { timestampFormat: "24-hour", nowMs: written.getTime(), locale: "fr" },
    ).lead,
  ).toBe("dans 10 heures");
  const regional = mentionedTimes("9:30 am America/New_York", written)[0]!;
  expect(regional.text.slice(0, regional.chipEnd - regional.start)).toBe("9:30 am");
});
