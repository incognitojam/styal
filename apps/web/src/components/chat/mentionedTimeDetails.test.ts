import {
  type MentionedTime,
  type MentionedTimeAnchor,
  resolveMentionedTime,
} from "@t3tools/client-runtime/mentioned-times";
import { describe, expect, it } from "vite-plus/test";

import { describeMentionedTime } from "./mentionedTimeDetails";

// Written in the machine's own zone, so the expectations hold wherever the tests run.
const LOCAL_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const local = (day: number, hour: number, minute = 0) =>
  new Date(2026, 10, day, hour, minute).getTime();

function describe_(time: MentionedTime, anchor: MentionedTimeAnchor, nowMs: number) {
  const resolved = resolveMentionedTime(time, anchor)!;
  return describeMentionedTime(time, anchor, resolved, {
    timestampFormat: "24-hour",
    readerTimeZone: LOCAL_ZONE,
    nowMs,
  });
}

describe("describeMentionedTime", () => {
  const anchor = { writtenAtMs: local(4, 1, 0), environmentTimeZone: LOCAL_ZONE };

  it("says only how far away a time is when the text already gives its day and the reader's zone", () => {
    const time: MentionedTime = {
      kind: "clock",
      hour: 14,
      minute: 20,
      dayOffset: 0,
      zone: { timeZone: LOCAL_ZONE },
    };
    expect(describe_(time, anchor, local(4, 11, 20))).toEqual({
      lead: "in 3 hours",
      detail: null,
      note: null,
    });
  });

  it("adds the day the text left out and says it was assumed", () => {
    const time: MentionedTime = { kind: "clock", hour: 19, minute: 30 };
    const details = describe_(time, anchor, local(4, 1, 5));
    expect(details.lead).toBe("5 hours ago");
    expect(details.detail).toBe("Yesterday");
    expect(details.note).toBe("Assumed date");
  });

  it("shows the reader's time and the written zone when they differ", () => {
    const time: MentionedTime = {
      kind: "clock",
      hour: 14,
      minute: 20,
      date: { year: 2026, month: 11, day: 4 },
      zone: { offsetMinutes: 13 * 60 + 45 },
    };
    const details = describe_(time, anchor, local(4, 1, 5));
    expect(details.detail).not.toBeNull();
    expect(details.detail).not.toContain("14:20");
    expect(details.note).toBe("Converted from UTC+13:45");
  });

  it("does not repeat a written yesterday, leading with the converted time instead", () => {
    const time: MentionedTime = {
      kind: "clock",
      hour: 9,
      minute: 20,
      dayOffset: -1,
      zone: { offsetMinutes: 13 * 60 + 45 },
    };
    const details = describe_(time, anchor, local(4, 1, 5));
    expect(details.lead).not.toBe("yesterday");
    expect(details.lead).not.toContain("09:20");
    expect(details.detail).toBeNull();
    expect(details.note).toBe("Converted from UTC+13:45");
  });

  it("shows a day a model read from the reply and says where it came from", () => {
    const time: MentionedTime = {
      kind: "clock",
      hour: 19,
      minute: 30,
      date: { year: 2026, month: 11, day: 1 },
      dateFromCheck: true,
    };
    const details = describe_(time, anchor, local(4, 1, 5));
    expect(details.lead).toBe("2 days ago");
    expect(details.detail).not.toBeNull();
    expect(details.note).toBe("Day from the reply");
  });

  it("gives the moment an offset lands on rather than the offset again", () => {
    const time: MentionedTime = { kind: "offset", milliseconds: -49 * 60_000 };
    const details = describe_(time, anchor, local(4, 1, 5));
    expect(details.lead).toBe("Today at 00:11");
    expect(details.detail).toBeNull();
    expect(details.note).toBe("Counted from when sent");
  });
});
