import { describe, expect, it } from "vite-plus/test";
import {
  acknowledgeReportResponse,
  answeredReportResult,
  claimReportResponse,
  coordinatorReports,
  formatReportAnswer,
  pendingReportAnswers,
  pendingReportDismissals,
  pendingReportResponseCount,
  reportAnswerDisplay,
  reportAnswers,
  reportResponseDelivered,
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
    const resolved = {
      ...report("c", "pr:1", 2),
      report: { ...report("c", "pr:1", 2).report, resolved: { at: "2026-11-19T00:00:00Z" } },
    };
    expect(coordinatorReports([...messages.slice(0, 2), resolved], []).map((x) => x.state)).toEqual(
      ["replaced", "open", "resolved"],
    );
    expect(
      coordinatorReports(
        [
          resolved,
          report("d", "pr:2", 1),
          report("e", "pr:3", 1),
          { ...answer, reportAnswer: { messageId: "d", key: "pr:2", version: 1 } },
        ],
        [{ messageId: "e", key: "pr:3", version: 1 }],
      ).map((x) => x.state),
    ).toEqual(["resolved", "answered", "dismissed"]);
    // A person's answer, even one an older client sent after the resolve, stands.
    expect(
      coordinatorReports(
        [resolved, { ...answer, reportAnswer: { messageId: "c", key: "pr:1", version: 2 } }],
        [],
      )[0]?.state,
    ).toBe("answered");
    expect(
      coordinatorReports([...messages.slice(0, 2), resolved, report("d", "pr:1", 3)], []).map(
        (x) => x.state,
      ),
    ).toEqual(["replaced", "open", "replaced", "open"]);
  });

  it("leaves the question open after a typed reply and closes it on a tapped answer", () => {
    const reply = {
      id: "reply",
      role: "user",
      text: formatReportAnswer({ title: "pr:1", version: 1 }, "Does it cover mobile?"),
    };
    const tap = {
      id: "tap",
      role: "user",
      text: formatReportAnswer({ title: "pr:1", version: 1 }, "Merge"),
      reportAnswer: { messageId: "a", key: "pr:1", version: 1 },
    };
    const messages = [report("a", "pr:1", 1), reply];
    expect(coordinatorReports(messages, [])[0]?.state).toBe("open");
    expect(coordinatorReports([...messages, tap], [])[0]).toMatchObject({
      state: "answered",
      answer: { id: "tap" },
    });
    expect([...reportAnswers([...messages, tap])]).toEqual([
      ["reply", { messageId: "a", title: "pr:1", version: 1, text: "Does it cover mobile?" }],
      ["tap", { messageId: "a", title: "pr:1", version: 1, text: "Merge" }],
    ]);
    // A title that contains another report's prefix: the longest match, as the server picks it.
    const nested = {
      ...report("n", "pr:2", 1),
      report: { ...report("n", "pr:2", 1).report, title: "pr:1, version 1] notes" },
    };
    const nestedReply = {
      id: "nested",
      role: "user",
      text: "[pr:1, version 1] notes, version 1] Why?",
    };
    expect(
      reportAnswers([report("a", "pr:1", 1), nested, nestedReply]).get("nested"),
    ).toMatchObject({
      messageId: "n",
      text: "Why?",
    });
  });

  it("shows a result recorded after the answer, not a resolve the answer reopened", () => {
    const resolved = { at: "2026-11-20T10:00:00.000Z", outcome: "Merged" };
    expect(answeredReportResult({ resolved }, { createdAt: "2026-11-20T09:59:00.000Z" })).toBe(
      "Merged",
    );
    expect(
      answeredReportResult({ resolved }, { createdAt: "2026-11-20T10:01:00.000Z" }),
    ).toBeUndefined();
    expect(
      answeredReportResult({ resolved }, { createdAt: "2026-11-20T09:59:00.000Z", pending: true }),
    ).toBeUndefined();
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

  it("keeps one response per report and reads it as given", () => {
    const ref = { messageId: "a", key: "pr:1", version: 1 };
    const answer = (messageId: string, text: string) => ({
      ref,
      kind: "answer" as const,
      messageId,
      text,
      createdAt: "2026-11-19T00:00:00.000Z",
    });
    const first = claimReportResponse([], answer("m1", "[pr:1, version 1] Merge it"));
    expect(first).not.toBeNull();
    // A double click, a different answer, and a dismiss before the first settles send nothing.
    expect(claimReportResponse(first!, answer("m2", "Merge it"))).toBeNull();
    expect(claimReportResponse(first!, answer("m3", "Hold"))).toBeNull();
    expect(claimReportResponse(first!, { ref, kind: "dismiss" })).toBeNull();
    // Another report, or another version of it, is still free.
    expect(
      claimReportResponse(first!, { ...answer("m4", "Hold"), ref: { ...ref, version: 2 } }),
    ).not.toBeNull();

    const messages = [report("a", "pr:1", 1)];
    expect(coordinatorReports([...messages, ...pendingReportAnswers(first!)], [])[0]?.state).toBe(
      "answered",
    );
    const dismissed = claimReportResponse([], { ref, kind: "dismiss" })!;
    expect(coordinatorReports(messages, pendingReportDismissals(dismissed))[0]?.state).toBe(
      "dismissed",
    );

    // A thread list that has reached the acknowledgement already counts the answer.
    const sent = acknowledgeReportResponse(first!, answer("m1", ""), 10);
    expect(pendingReportResponseCount(sent, 9)).toBe(1);
    expect(pendingReportResponseCount(sent, 10)).toBe(0);

    // Cancelling a queued answer keeps its message but drops its report reference, so it was
    // not delivered.
    expect(reportResponseDelivered({ messages: [{ id: "m1" }], dismissals: [] }, sent[0]!)).toBe(
      false,
    );
    expect(
      reportResponseDelivered(
        { messages: [{ id: "m1", reportAnswer: ref }], dismissals: [] },
        sent[0]!,
      ),
    ).toBe(true);
  });
});
