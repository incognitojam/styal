// @effect-diagnostics globalDate:off -- Assertions read resolved instants as ISO strings.
import { describe, expect, it } from "vite-plus/test";

import {
  findMentionedTimes,
  findMessageZone,
  type MentionedTimeAnchor,
  resolveMentionedTime,
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
