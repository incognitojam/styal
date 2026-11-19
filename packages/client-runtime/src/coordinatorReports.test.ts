import { describe, expect, it } from "vite-plus/test";
import {
  coordinatorReports,
  formatReportAnswer,
  reportAcceptsAnswer,
  reportAnswerDisplay,
  splitReportAnswer,
} from "./coordinatorReports.ts";
const report = (id: string, key: string, version: number) => ({
  id,
  role: "assistant",
  text: "Report",
  report: { key, title: key, version, question: "Merge?" },
});
describe("coordinator reports", () => {
  it("keeps unrelated messages open, supersedes by key, and answers only the exact version", () => {
    const messages = [
      report("a", "pr:1", 1),
      report("b", "pr:2", 1),
      report("c", "pr:1", 2),
      { id: "u", role: "user", text: "Hello" },
    ];
    expect(coordinatorReports(messages, []).map((x) => [x.message.id, x.state])).toEqual([
      ["a", "replaced"],
      ["b", "open"],
      ["c", "open"],
    ]);
    const answer = {
      id: "reply",
      role: "user",
      text: "Merge",
      reportAnswer: { messageId: "a", key: "pr:1", version: 1 },
    };
    expect(
      coordinatorReports([...messages, answer], [{ messageId: "b", key: "pr:2", version: 1 }]).map(
        (x) => x.state,
      ),
    ).toEqual(["replaced", "dismissed", "open"]);
    expect(
      coordinatorReports(
        [...messages, { ...answer, reportAnswer: { messageId: "c", key: "pr:1", version: 2 } }],
        [],
      )[2]?.state,
    ).toBe("answered");
    expect(
      coordinatorReports(
        [report("a", "pr:1", 1), report("b", "pr:1", 2), report("c", "pr:1", 3)],
        [],
      ).map((x) => x.latest.report?.version),
    ).toEqual([3, 3, 3]);
  });

  it("shows an answer that has not reached the server as sending, until the real one arrives", () => {
    const open = report("a", "pr:1", 1);
    const pending = {
      text: formatReportAnswer({ title: "pr:1", version: 1 }, "Merge"),
      reportAnswer: { messageId: "a", key: "pr:1", version: 1 },
    };
    const [sending] = coordinatorReports([open], [], [pending]);
    expect(sending?.state).toBe("sending");
    expect(sending?.pending).toBe(pending);
    // An answer to another version leaves this one open.
    expect(
      coordinatorReports(
        [open],
        [],
        [{ ...pending, reportAnswer: { ...pending.reportAnswer, version: 2 } }],
      )[0]?.state,
    ).toBe("open");
    // A typed reply submitted while that answer is still on its way finds the report taken.
    expect(
      reportAcceptsAnswer(coordinatorReports([open], [], [pending]), pending.reportAnswer),
    ).toBe(false);
    expect(reportAcceptsAnswer(coordinatorReports([open], []), pending.reportAnswer)).toBe(true);
    const answered = { id: "reply", role: "user", ...pending };
    expect(coordinatorReports([open, answered], [], [pending])[0]?.state).toBe("answered");
  });

  it("splits only the answered report's own prefix and keeps the rest as typed", () => {
    const report = { title: "#1522 cleanup, ready", version: 2 };
    expect(splitReportAnswer(formatReportAnswer(report, "Wait\nfor 88"), report)).toBe(
      "Wait\nfor 88",
    );
    const build = { title: "Build", version: 2 };
    expect(
      splitReportAnswer(formatReportAnswer(build, "Please keep [Other, version 2] visible"), build),
    ).toBe("Please keep [Other, version 2] visible");
    expect(splitReportAnswer(formatReportAnswer(report, "Wait"), { ...report, version: 1 })).toBe(
      null,
    );
    expect(splitReportAnswer("Wait for 88", report)).toBeNull();
  });

  it("shows an answer as one line only when it is a tapped answer with nothing attached", () => {
    const report = { title: "#44 Retry", version: 1, answers: ["Start it", "Not yet"] };
    const answer = (text: string, attachments: readonly unknown[] = []) => ({
      text: formatReportAnswer(report, text),
      attachments,
    });
    expect(reportAnswerDisplay(answer("Start it"), report)).toEqual({
      text: "Start it",
      compact: true,
    });
    expect(reportAnswerDisplay(answer("Start it", [{ id: "a" }]), report).compact).toBe(false);
    expect(
      reportAnswerDisplay(answer("Start it ![shot.png](t3-context://v1/image/image_1)"), report)
        .compact,
    ).toBe(false);
    expect(reportAnswerDisplay(answer("Start it\nafter lunch"), report).compact).toBe(false);
  });
});
