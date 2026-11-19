import { describe, expect, it } from "vite-plus/test";

import { findOpenedReport, reportBodyMarkdown, reportFinished } from "./threadReport.logic";

const report = (id: string, state: string) => ({ message: { id }, state });

describe("reportFinished", () => {
  it("finishes once an answer or a dismissal is on record, not when a newer version arrives", () => {
    expect(reportFinished(report("r", "answered"))).toBe(true);
    expect(reportFinished(report("r", "dismissed"))).toBe(true);
    expect(reportFinished(report("r", "open"))).toBe(false);
    expect(reportFinished(report("r", "replaced"))).toBe(false);
    // A typed reply to version 1 lands after version 2 replaced it.
    expect(reportFinished({ ...report("r", "replaced"), answer: { id: "reply" } })).toBe(true);
  });
});

describe("findOpenedReport", () => {
  const history = { loading: false, hasMoreHistory: false, error: null };
  it("waits for a report older than the loaded history, and gives up once all of it is loaded", () => {
    const reports = [report("report-1", "open")];
    expect(findOpenedReport(reports, "report-1", { ready: true, history }).kind).toBe("found");
    expect(findOpenedReport([], "report-1", { ready: false, history }).kind).toBe("loading");
    expect(
      findOpenedReport([], "report-1", {
        ready: true,
        history: { ...history, hasMoreHistory: true },
      }).kind,
    ).toBe("loading");
    expect(
      findOpenedReport([], "report-1", { ready: true, history: { ...history, loading: true } })
        .kind,
    ).toBe("loading");
    // Removed, or coordinator reports switched off.
    expect(findOpenedReport([], "report-1", { ready: true, history }).kind).toBe("gone");
    expect(
      findOpenedReport([], "report-1", {
        ready: true,
        history: { ...history, hasMoreHistory: true, error: "Offline" },
      }).kind,
    ).toBe("gone");
  });
});

describe("reportBodyMarkdown", () => {
  it("drops a leading heading that repeats the title, and nothing else", () => {
    expect(
      reportBodyMarkdown("## Tag search matching\n\nThe index is built.", "Tag search matching"),
    ).toBe("The index is built.");
    expect(reportBodyMarkdown("## Background\n\nThe index is built.", "Tag search matching")).toBe(
      "## Background\n\nThe index is built.",
    );
    expect(reportBodyMarkdown("The index is built.", "Tag search matching")).toBe(
      "The index is built.",
    );
  });
});
