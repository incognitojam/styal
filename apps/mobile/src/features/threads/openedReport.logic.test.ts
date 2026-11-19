import { MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  needsListRoute,
  openedReportFinished,
  openedReportGone,
  openedReportView,
  type OpenedReport,
} from "./openedReport.logic";

const report = (id: string, state: string) => ({ message: { id }, state });
const opened: OpenedReport = {
  threadKey: "env:chat",
  id: MessageId.make("report-1"),
  returnTo: null,
};

describe("openedReportView", () => {
  it("shows the opened report's answers until the composer replies to it", () => {
    const reports = [report("report-1", "open")];
    expect(openedReportView(opened, "env:chat", reports, null)).toEqual({
      report: reports[0],
      visible: true,
    });
    expect(openedReportView(opened, "env:chat", reports, "report-1")?.visible).toBe(false);
  });

  it("lets go when the report disappears or belongs to another thread", () => {
    // Coordinator reports switched off empties the list; the bar must come back.
    expect(openedReportView(opened, "env:chat", [], null)).toBeNull();
    expect(openedReportView(opened, "env:other", [report("report-1", "open")], null)).toBeNull();
    expect(openedReportView(null, "env:chat", [report("report-1", "open")], null)).toBeNull();
  });
});

describe("openedReportFinished", () => {
  it("finishes once an answer or a dismissal is on record, not when a newer version arrives", () => {
    expect(openedReportFinished(report("r", "answered"))).toBe(true);
    expect(openedReportFinished(report("r", "dismissed"))).toBe(true);
    expect(openedReportFinished(report("r", "open"))).toBe(false);
    expect(openedReportFinished(report("r", "replaced"))).toBe(false);
    // A typed reply to version 1 lands after version 2 replaced it.
    expect(openedReportFinished({ ...report("r", "replaced"), answer: { id: "reply" } })).toBe(
      true,
    );
  });
});

describe("openedReportGone", () => {
  it("forgets a report the loaded thread no longer lists, but waits while it loads", () => {
    const reports = [report("report-1", "open")];
    expect(openedReportGone(opened, "env:chat", reports, true)).toBe(false);
    // Coordinator reports switched off, or the report removed: forget it, so switching them
    // back on brings neither the pin nor a late return back.
    expect(openedReportGone(opened, "env:chat", [], true)).toBe(true);
    expect(openedReportGone(opened, "env:chat", [], false)).toBe(false);
    expect(openedReportGone(opened, "env:other", reports, true)).toBe(true);
    expect(openedReportGone(null, "env:chat", [], true)).toBe(false);
  });
});

describe("needsListRoute", () => {
  const routes = [{ key: "home" }, { key: "chat-route" }, { key: "thread-route" }];
  it("returns only to the project chat that opened the report, directly below", () => {
    expect(needsListRoute({ index: 2, routes }, "chat-route")).toBe("chat-route");
    // The chat route was replaced, or something else is below now: stay put.
    expect(needsListRoute({ index: 2, routes }, "gone-route")).toBeNull();
    expect(needsListRoute({ index: 1, routes }, "chat-route")).toBeNull();
  });
});
