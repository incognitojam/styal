import { describe, expect, it } from "vite-plus/test";

import { advanceSettledShelfFocus, type SettledShelfFocus } from "./threadSettled.ts";

const active = (threadKey: string, latestUserMessageAt: string | null = null) =>
  ({ threadKey, settled: false, latestUserMessageAt }) satisfies SettledShelfFocus;
const settled = (threadKey: string, latestUserMessageAt: string | null = null) =>
  ({ threadKey, settled: true, latestUserMessageAt }) satisfies SettledShelfFocus;
const noThread = { threadKey: null, settled: false, latestUserMessageAt: undefined };

/** Feeds focus snapshots through the rule and reports which steps collapsed. */
function collapses(start: SettledShelfFocus, steps: ReadonlyArray<SettledShelfFocus>): boolean[] {
  let focus = start;
  return steps.map((next) => {
    const result = advanceSettledShelfFocus(focus, next);
    focus = result.focus;
    return result.collapse;
  });
}

describe("advanceSettledShelfFocus", () => {
  it("stays open while browsing and un-settling settled threads", () => {
    expect(
      collapses(active("a"), [
        settled("s1"),
        settled("s2"),
        // Un-settling the open thread, then another from its row.
        active("s2"),
        settled("s3"),
        active("s3"),
      ]),
    ).toEqual([false, false, false, false, false]);
  });

  it("collapses when opening a thread outside the shelf", () => {
    expect(collapses(settled("s1"), [active("a")])).toEqual([true]);
    expect(collapses(active("a"), [active("b")])).toEqual([true]);
  });

  it("collapses when a message is sent in the open thread, settled or not", () => {
    expect(
      collapses(settled("s1", "2026-04-10T09:00:00.000Z"), [
        active("s1", "2026-04-10T12:00:00.000Z"),
      ]),
    ).toEqual([true]);
    expect(collapses(active("a"), [active("a", "2026-04-10T12:00:00.000Z")])).toEqual([true]);
  });

  it("does not treat a shell arriving for the open thread as a sent message", () => {
    const loading = { threadKey: "a", settled: false, latestUserMessageAt: undefined };
    expect(collapses(noThread, [loading, active("a", "2026-04-10T12:00:00.000Z")])).toEqual([
      true,
      false,
    ]);
  });

  it("keeps the last thread across non-thread screens", () => {
    expect(collapses(active("a"), [noThread, active("a")])).toEqual([false, false]);
    expect(collapses(active("a"), [noThread, active("b")])).toEqual([false, true]);
  });
});
