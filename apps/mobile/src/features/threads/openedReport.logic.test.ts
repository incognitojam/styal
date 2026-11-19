import { MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  needsListRoute,
  openedReportFinished,
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
