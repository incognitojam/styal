// @effect-diagnostics globalDate:off -- Assertions read resolved instants as ISO strings.
import { describe, expect, it } from "vite-plus/test";

import {
  applyMentionedTimeCheck,
  findMentionedTimes,
  findMessageZone,
  type MentionedTimeAnchor,
  resolveMentionedTime,
  tableColumnHoldsDurations,
} from "./mentionedTimes.ts";

function matchedText(text: string): string[] {
  return findMentionedTimes(text).map((match) => text.slice(match.start, match.end));
}

function resolveAll(text: string, anchor: MentionedTimeAnchor): (string | null)[] {
  return findMentionedTimes(text, { messageZone: findMessageZone(text) }).map((match) => {
    const resolved = resolveMentionedTime(match.time, anchor);
    return resolved === null ? null : new Date(resolved.instantMs).toISOString();
  });
}

const LONDON_AFTERNOON: MentionedTimeAnchor = {
  writtenAtMs: Date.parse("2026-10-01T14:08:00Z"),
  environmentTimeZone: "Europe/London",
};

describe("findMentionedTimes", () => {
  it.each([
    ["PR 330 merged at 14:39 UTC.", ["14:39 UTC"]],
    ["15:55:19 UTC: the worker started.", ["15:55:19 UTC"]],
    ["15:55:43: a message arrived.", ["15:55:43"]],
    ["About 15:55:45:", ["15:55:45"]],
    ["16:20: the retry started.", ["16:20"]],
    ["16:21 UTC:\nThe retry finished.", ["16:21 UTC"]],
    ["2026-10-10T15:55:19+01:00: the worker started.", ["2026-10-10T15:55:19+01:00"]],
    ["finished at **15:52:27 UTC** today", ["15:52:27 UTC"]],
    ["the browser shows 3:41 PM BST", ["3:41 PM BST"]],
    ["merged at 14:20 (UTC)", ["14:20 (UTC)"]],
    ["merged at 14:20 in UTC", ["14:20 in UTC"]],
    ["committed 2026-09-18 11:42 UTC", ["2026-09-18 11:42 UTC"]],
    ["landed at 2026-09-29T20:30Z", ["2026-09-29T20:30Z"]],
    ["at 2026-09-23 12:12:00+00:00 exactly", ["2026-09-23 12:12:00+00:00"]],
    ["Authored: August 25, 2026 at 19:11 BST", ["August 25, 2026 at 19:11 BST"]],
    ["- Tue 8 Sep 11:47, the screenshot", ["Tue 8 Sep 11:47"]],
    ["merged on 29 September at 18:15 UTC", ["29 September at 18:15 UTC"]],
    ["the build started yesterday at 11:41 UTC", ["yesterday at 11:41 UTC"]],
    ["see you Sunday 17:00", ["Sunday 17:00"]],
    ["call at 9am tomorrow", ["9am tomorrow"]],
    ["the session file was touched at 15:11 today", ["15:11 today"]],
    [
      "last run 49 minutes ago, next due in about 18 minutes",
      ["49 minutes ago", "in about 18 minutes"],
    ],
    ["Yes, about 5 hours and 19 minutes ago.", ["about 5 hours and 19 minutes ago"]],
    ["I'll check back in about five minutes.", ["in about five minutes"]],
    ["the build that took ages finished at 17:25", ["17:25"]],
    ["the call lasted until 17:25", ["17:25"]],
    ["the call took 17:25 UTC", ["17:25 UTC"]],
    ["the build failed in 16:11 UTC", ["16:11 UTC"]],
  ])("finds the time in %j", (text, expected) => {
    expect(matchedText(text)).toEqual(expected);
  });

  it.each([
    ["CI finished that step in 2:48 and 4:11"],
    ["Elapsed 2:48: the step finished."],
    ["see src/example.ts:12:34: for the call"],
    ["the identifier is 15:55:43:123"],
    ["the identifier is 15:55:43:error"],
    ["the invalid time is 15:55:99: or 24:55:"],
    ["the IPv6 suffix is ::12:34:"],
    ["see src/index.ts:12:34 for the call"],
    ["the screen is 16:9"],
    ["all tests completed in 69 seconds"],
    ["Clerk requests time out after 15 seconds"],
    ["the reaper runs after 30 minutes idle"],
    ['labels such as "5 min ago" and "2 hours ago"'],
    ["the run took 1 hour"],
    ["rated at 300 PM2.5"],
    ["the call took 17:25"],
    ["the call lasted 17:25 in total"],
    ["Length: 17:25"],
    ["a runtime of 17:25:03"],
    ["Duration is 12:40."],
    ["88 passed, 1 skipped in 16:11."],
  ])("finds no time in %j", (text) => {
    expect(matchedText(text)).toEqual([]);
  });

  it("leaves out abbreviations that name more than one zone", () => {
    const [match] = findMentionedTimes("the call is at 14:20 IST");
    expect(match?.time).toEqual({ kind: "clock", hour: 14, minute: 20 });
  });

  it("takes the zone a message uses throughout for times written without one", () => {
    const text = "The Mac slept at 18:37:10 BST and woke at 18:42:54.";
    expect(resolveAll(text, LONDON_AFTERNOON)).toEqual([
      "2026-10-01T17:37:10.000Z",
      "2026-10-01T17:42:54.000Z",
    ]);
    const table = "| Time (UTC) | Event |\n|---|---|\n| 12:17:07 | Worktree created |";
    expect(findMessageZone(table)).toEqual({ offsetMinutes: 0, name: "UTC" });
  });

  it("keeps a written zone before a label colon and shares it with other times", () => {
    const text = "15:55:19 UTC: started. 15:55:43: arrived. About 15:55:45: caught up.";
    const zone = findMessageZone(text);
    expect(zone).toEqual({ offsetMinutes: 0, name: "UTC" });
    expect(findMentionedTimes(text, { messageZone: zone }).map((match) => match.time)).toEqual([
      { kind: "clock", hour: 15, minute: 55, second: 19, zone },
      { kind: "clock", hour: 15, minute: 55, second: 43, zone, zoneFromMessage: true },
      { kind: "clock", hour: 15, minute: 55, second: 45, zone, zoneFromMessage: true },
    ]);
    expect(resolveAll(text, LONDON_AFTERNOON)).toEqual([
      "2026-10-01T15:55:19.000Z",
      "2026-10-01T15:55:43.000Z",
      "2026-10-01T15:55:45.000Z",
    ]);
  });

  it("treats a zone in parentheses or after 'in' as written with the time", () => {
    for (const text of ["merged at 14:20 (UTC)", "merged at 14:20 in UTC"]) {
      const [match] = findMentionedTimes(text, { messageZone: findMessageZone(text) });
      expect(match?.time).toMatchObject({ zone: { offsetMinutes: 0, name: "UTC" } });
      expect(match?.time).not.toHaveProperty("zoneFromMessage");
    }
  });

  it("keeps the environment's zone when a message names more than one", () => {
    const text = "the browser shows 3:41 PM BST while the server logs 14:41 UTC";
    expect(findMessageZone(text)).toBeNull();
  });

  it("gives the start of a range the zone written at its end", () => {
    const text = "Started / finished: 19:32:31 to 19:34:27 BST";
    const evening = { ...LONDON_AFTERNOON, writtenAtMs: Date.parse("2026-10-01T18:40:00Z") };
    expect(resolveAll(text, evening)).toEqual([
      "2026-10-01T18:32:31.000Z",
      "2026-10-01T18:34:27.000Z",
    ]);
  });
});

describe("tableColumnHoldsDurations", () => {
  it.each([
    ["Length", ["0:02", "17:25"], true],
    ["Time taken", ["17:25"], true],
    ["Wall time", ["17:25"], true],
    ["", ["17:25", "44:08"], true],
    ["Call", ["17:25", "28:18"], true],
    ["Time", ["9:05", "17:25"], false],
    ["Started", ["17:25", "44:08"], false],
    ["Call", ["4:15", "17:25"], false],
    ["Recording", ["17:25", "09:00"], false],
  ])("reads the %j column of %j as durations: %s", (header, cells, expected) => {
    expect(tableColumnHoldsDurations(header, cells)).toBe(expected);
  });

  it("keeps a time with a zone, date, or am/pm in a column of durations", () => {
    for (const text of ["17:25 UTC", "yesterday at 17:25", "5:25 pm"]) {
      expect(findMentionedTimes(text, { durations: true })).toHaveLength(1);
    }
    expect(findMentionedTimes("17:25", { durations: true })).toEqual([]);
  });
});

describe("resolveMentionedTime", () => {
  it("converts a written zone without needing the environment's", () => {
    const anchor = { ...LONDON_AFTERNOON, environmentTimeZone: null };
    expect(resolveAll("merged at 14:39 UTC", anchor)).toEqual(["2026-10-01T14:39:00.000Z"]);
  });

  it("reads a zone-less time in the environment's zone", () => {
    expect(resolveAll("touched at 15:11", LONDON_AFTERNOON)).toEqual(["2026-10-01T14:11:00.000Z"]);
    const utcServer = { ...LONDON_AFTERNOON, environmentTimeZone: "UTC" };
    expect(resolveAll("touched at 15:11", utcServer)).toEqual(["2026-10-01T15:11:00.000Z"]);
  });

  it("leaves a zone-less time unresolved when the environment's zone is unknown", () => {
    const anchor = { ...LONDON_AFTERNOON, environmentTimeZone: null };
    expect(resolveAll("touched at 15:11", anchor)).toEqual([null]);
  });

  it("takes the occurrence nearest to when the message was written", () => {
    const justAfterMidnight = {
      writtenAtMs: Date.parse("2026-10-02T00:20:00Z"),
      environmentTimeZone: "UTC",
    };
    const [match] = findMentionedTimes("the deploy failed at 23:50");
    expect(resolveMentionedTime(match!.time, justAfterMidnight)).toEqual({
      instantMs: Date.parse("2026-10-01T23:50:00Z"),
      assumedEnvironmentZone: true,
      zoneFromMessage: false,
      assumedDay: true,
      fromWrittenAt: false,
    });
  });

  it("follows a tense cue when the nearest occurrence is well on the other side", () => {
    const evening = { writtenAtMs: Date.parse("2026-09-19T18:33:00Z"), environmentTimeZone: "UTC" };
    expect(resolveAll("last finished 11:45 UTC, next at 07:00", evening)).toEqual([
      "2026-09-19T11:45:00.000Z",
      "2026-09-20T07:00:00.000Z",
    ]);
    const midday = { writtenAtMs: Date.parse("2026-09-23T11:44:00Z"), environmentTimeZone: "UTC" };
    expect(resolveAll("#9511 merged at 23:35 UTC", midday)).toEqual(["2026-09-22T23:35:00.000Z"]);
  });

  it("keeps the nearest occurrence when a tense cue would move a time only hours away", () => {
    const morning = { writtenAtMs: Date.parse("2026-09-29T10:41:00Z"), environmentTimeZone: "UTC" };
    expect(
      resolveAll("the next slow shutdown should show what hung during the 08:50 restart", morning),
    ).toEqual(["2026-09-29T08:50:00.000Z"]);
  });

  it("takes the nearest matching weekday and the nearest year", () => {
    // 1 October 2026 is a Thursday.
    expect(resolveAll("Sunday 17:00 UTC", LONDON_AFTERNOON)).toEqual(["2026-10-04T17:00:00.000Z"]);
    expect(resolveAll("Monday 09:00 UTC", LONDON_AFTERNOON)).toEqual(["2026-09-28T09:00:00.000Z"]);
    const newYear = { writtenAtMs: Date.parse("2027-01-02T10:00:00Z"), environmentTimeZone: "UTC" };
    expect(resolveAll("on 31 December at 23:00", newYear)).toEqual(["2026-12-31T23:00:00.000Z"]);
  });

  it("follows daylight saving for regional zones", () => {
    expect(resolveAll("2026-07-01 15:00 EST and 2026-12-01 15:00 EST", LONDON_AFTERNOON)).toEqual([
      "2026-07-01T19:00:00.000Z",
      "2026-12-01T20:00:00.000Z",
    ]);
    expect(resolveAll("2026-12-01 15:00", LONDON_AFTERNOON)).toEqual(["2026-12-01T15:00:00.000Z"]);
  });

  it("counts offsets from when the message was written", () => {
    expect(
      resolveAll("last run 49 minutes ago, due in about 18 minutes", LONDON_AFTERNOON),
    ).toEqual(["2026-10-01T13:19:00.000Z", "2026-10-01T14:26:00.000Z"]);
  });

  it("rejects dates that do not exist", () => {
    expect(resolveAll("on 31 September at 10:00 UTC", LONDON_AFTERNOON)).toEqual([null]);
  });
});

describe("applyMentionedTimeCheck", () => {
  const spanOf = (text: string, needle: string) => {
    const start = text.indexOf(needle);
    return { start, end: start + needle.length, text: needle };
  };

  it("drops a time the model reads as a length or an example", () => {
    const text = "Recording b ran 17:25; the format looks like 14:30.";
    const result = applyMentionedTimeCheck(text, 0, findMentionedTimes(text), [
      { ...spanOf(text, "17:25"), kind: "length" },
      { ...spanOf(text, "14:30"), kind: "other" },
    ]);
    expect(result).toEqual([]);
  });

  it("gives a moment the day the message implies instead of the nearest one", () => {
    const text = "The stall on terra at 19:08 hit one of these steps.";
    const [result] = applyMentionedTimeCheck(text, 0, findMentionedTimes(text), [
      { ...spanOf(text, "19:08"), kind: "moment", time: "19:08", date: "2026-09-29" },
    ]);
    const resolved = resolveMentionedTime(result!.time, {
      writtenAtMs: Date.parse("2026-09-30T10:18:00Z"),
      environmentTimeZone: "Europe/London",
    });
    expect(new Date(resolved!.instantMs).toISOString()).toBe("2026-09-29T18:08:00.000Z");
    expect(resolved!.assumedDay).toBe(false);
  });

  it("adds a time the rules skipped when the model gives its time of day", () => {
    const text = "The pill still read Working at 8:05, so it is stale.";
    expect(findMentionedTimes(text)).toEqual([]);
    const result = applyMentionedTimeCheck(
      text,
      0,
      [],
      [{ ...spanOf(text, "8:05"), kind: "moment", time: "20:05", date: "2026-10-20" }],
    );
    expect(result).toEqual([
      {
        start: text.indexOf("8:05"),
        end: text.indexOf("8:05") + 4,
        time: { kind: "clock", hour: 20, minute: 5, date: { year: 2026, month: 10, day: 20 } },
      },
    ]);
  });

  it("does not add a time in a zone it cannot read", () => {
    const text = "Around 20:00 UK time the watch is due.";
    const span = {
      ...spanOf(text, "20:00"),
      kind: "moment" as const,
      time: "20:00",
      zone: "UK time",
    };
    expect(applyMentionedTimeCheck(text, 0, [], [span])).toEqual([]);
  });

  it("finds a span in text that starts later in the message", () => {
    const message = "**Recording b:** 17:25, then 14:30.";
    const text = " 17:25, then 14:30.";
    const offset = message.indexOf(text);
    expect(findMentionedTimes(text)).toHaveLength(2);
    const result = applyMentionedTimeCheck(text, offset, findMentionedTimes(text), [
      { ...spanOf(message, "17:25"), kind: "length" },
    ]);
    expect(result.map((match) => text.slice(match.start, match.end))).toEqual(["14:30"]);
  });
});
