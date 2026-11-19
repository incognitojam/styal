import { describe, expect, it } from "vite-plus/test";
import { MessageId } from "@t3tools/contracts";
import {
  acknowledgeReportResponse,
  answeredReportStatus,
  claimReportResponse,
  coordinatorReports,
  failReportResponse,
  formatReportAnswer,
  needRowsWithResponses,
  pendingReportAnswers,
  pendingReportDismissals,
  pendingReportResponseCount,
  reportAnswerDelivery,
  reportAnswerDisplay,
  REPORT_ANSWER_FAILED,
  reportResponseFailure,
  reportResponsePending,
  settleReportResponses,
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

  it("keeps one response per report until it fails or the server shows it", () => {
    const ref = { messageId: "a", key: "pr:1", version: 1 };
    const answer = (messageId: string, text: string) => ({
      ref,
      kind: "answer" as const,
      messageId,
      text,
      createdAt: "2026-11-19T00:00:00.000Z",
    });
    const first = claimReportResponse([], answer("m1", "Merge it"));
    expect(first).not.toBeNull();
    // A double click, a different answer, and a dismiss before the first confirms send nothing.
    expect(claimReportResponse(first!, answer("m2", "Merge it"))).toBeNull();
    expect(claimReportResponse(first!, answer("m3", "Hold"))).toBeNull();
    expect(claimReportResponse(first!, { ref, kind: "dismiss" })).toBeNull();
    // Another report, or another version of it, is still free.
    expect(
      claimReportResponse(first!, { ...answer("m4", "Hold"), ref: { ...ref, version: 2 } }),
    ).not.toBeNull();

    const messages = [report("a", "pr:1", 1)];
    const answered = [...messages, ...pendingReportAnswers(first!)];
    expect(coordinatorReports(answered, [])[0]?.state).toBe("answered");
    const sending = pendingReportAnswers(first!).map((message) => message.id);
    expect(reportAnswerDelivery("m1", { sending, queued: [] })).toBe("sending");
    expect(reportAnswerDelivery("m1", { sending: [], queued: ["m1"] })).toBe("queued");
    expect(reportAnswerDelivery("m1", { sending: [], queued: [] })).toBe("delivered");

    // A failed send leaves the report open and free to answer again.
    const failed = failReportResponse(first!, ref, "Could not send your answer.");
    expect(pendingReportAnswers(failed)).toEqual([]);
    expect(reportResponseFailure(failed, ref)).toEqual({ message: "Could not send your answer." });
    expect(reportResponseFailure(first!, ref)).toBeUndefined();
    expect(coordinatorReports([...messages, ...pendingReportAnswers(failed)], [])[0]?.state).toBe(
      "open",
    );
    const retried = claimReportResponse(failed, answer("m5", "Hold"));
    expect(retried?.map((response) => response.failed)).toEqual([undefined]);
    expect(reportResponseFailure(retried!, ref)).toBeUndefined();

    // Settled once the server has the answer message or the dismissal.
    expect(settleReportResponses(first!, { messageIds: ["m1"], dismissals: [] })).toEqual([]);
    expect(settleReportResponses(first!, { messageIds: [], dismissals: [] })).toBe(first);
    const dismissed = claimReportResponse([], { ref, kind: "dismiss" })!;
    expect(pendingReportDismissals(dismissed)).toEqual([ref]);
    expect(settleReportResponses(dismissed, { messageIds: [], dismissals: [ref] })).toEqual([]);
  });

  it("frees a report whose answer was cancelled in the queue or never arrived", () => {
    const ref = { messageId: "a", key: "pr:1", version: 1 };
    const answer = {
      ref,
      kind: "answer" as const,
      messageId: "m1",
      text: "[pr:1, version 1] Merge it",
      createdAt: "2026-11-19T00:00:00.000Z",
    };
    const sent = acknowledgeReportResponse(claimReportResponse([], answer)!, answer, 10);
    expect(reportResponsePending(sent, answer)).toBe(true);
    // A thread summary that has reached the acknowledgement already counts the answer.
    expect(pendingReportResponseCount(sent, 9)).toBe(1);
    expect(pendingReportResponseCount(sent, 10)).toBe(0);

    // Cancelling a queued answer keeps its message but drops its report reference.
    const cancelled = settleReportResponses(sent, { messageIds: ["m1"], dismissals: [] });
    expect(cancelled).toEqual([]);
    expect(
      coordinatorReports(
        [report("a", "pr:1", 1), { id: "m1", role: "user", text: answer.text }],
        [],
      )[0]?.state,
    ).toBe("open");

    // A view older than the acknowledgement may simply not have it yet.
    expect(settleReportResponses(sent, { messageIds: [], dismissals: [], sequence: 9 })).toBe(sent);
    // One that has reached it without showing the answer never will.
    const lost = settleReportResponses(sent, { messageIds: [], dismissals: [], sequence: 10 });
    expect(reportResponsePending(lost, answer)).toBe(false);
    expect(reportResponseFailure(lost, ref)?.message).toBe(REPORT_ANSWER_FAILED);
    expect(claimReportResponse(lost, { ...answer, messageId: "m2" })).not.toBeNull();
  });
});

describe("answeredReportStatus", () => {
  it("keeps a sent answer's row answering until the agent has it", () => {
    const report = {
      key: "shed",
      title: "Shed",
      version: 2,
      question: "Start?",
      answers: ["Start it", "Hold"],
    };
    const ref = { messageId: MessageId.make("report"), key: "shed", version: 2 };
    const response = {
      ref,
      kind: "answer" as const,
      messageId: MessageId.make("answer"),
      text: "[Shed, version 2] Start it",
      createdAt: "2026-11-19T10:00:00.000Z",
    };
    const answered = { report, response };
    const projection = (queued: boolean, reportAnswer: typeof ref | null = ref) =>
      ({
        messages: [
          {
            id: response.messageId,
            role: "user",
            text: response.text,
            reportAnswer: reportAnswer ?? undefined,
          },
        ],
        runs: queued
          ? [{ id: "run", status: "queued", userMessageId: response.messageId, ordinal: 2 }]
          : [],
        thread: { reportDismissals: [] },
      }) as unknown as Parameters<typeof answeredReportStatus>[2];

    expect(answeredReportStatus(answered, [response], null)).toEqual({
      status: "sending",
      chosen: "Start it",
      reply: null,
    });
    expect(answeredReportStatus(answered, [], projection(true))).toMatchObject({
      status: "queued",
    });
    expect(answeredReportStatus(answered, [], projection(false))).toBe("delivered");
    // Before the thread loads, a response no longer pending may still be queued.
    expect(answeredReportStatus(answered, [], null)).toBe("unknown");
    // Cancelled in the queue: the message stays without its report reference.
    expect(answeredReportStatus(answered, [], projection(false, null))).toBe("withdrawn");
    expect(answeredReportStatus(answered, [{ ...response, failed: "Offline" }], null)).toBe(
      "failed",
    );
    // A typed reply has no offered answer to mark.
    expect(
      answeredReportStatus(
        { report, response: { ...response, text: "[Shed, version 2] Next week" } },
        [{ ...response, text: "[Shed, version 2] Next week" }],
        null,
      ),
    ).toEqual({ status: "sending", chosen: null, reply: "Next week" });
    expect(
      answeredReportStatus(
        { report, response: { ref, kind: "dismiss" } },
        [{ ref, kind: "dismiss" }],
        null,
      ),
    ).toMatchObject({ status: "dismissing" });
    // A dismissal is delivered only once the thread lists it, not when its pending entry goes.
    const dismissal = { report, response: { ref, kind: "dismiss" as const } };
    const loaded = projection(false);
    expect(answeredReportStatus(dismissal, [], loaded)).toBe("withdrawn");
    expect(
      answeredReportStatus(dismissal, [], {
        ...loaded!,
        thread: {
          ...loaded!.thread,
          reportDismissals: [{ ...ref, id: "d", occurredAt: "", text: "" }],
        },
      } as Parameters<typeof answeredReportStatus>[2]),
    ).toBe("delivered");
  });
});

describe("needRowsWithResponses", () => {
  it("keeps every response on its way in its place", () => {
    const need = (key: string, createdAt: string) => ({ key, createdAt });
    const [a, b, c] = [need("a", "1"), need("b", "2"), need("c", "3")];
    // A and C were answered here and are still queued; the open list no longer has them.
    expect(
      needRowsWithResponses(
        [b],
        [
          { need: c, responding: "queued" },
          { need: a, responding: "sending" },
        ],
      ),
    ).toEqual([{ need: a, responding: "sending" }, { need: b }, { need: c, responding: "queued" }]);
  });
});
