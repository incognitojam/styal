import { describe, expect, it } from "vite-plus/test";
import {
  coordinatorReports,
  pendingReportAnswers,
  type PendingReportResponse,
} from "@t3tools/client-runtime/coordinator-reports";

import {
  answerReportStack,
  closedReportStack,
  closeReportStack,
  deferReport,
  deferReportStack,
  landReportStack,
  openReportStack,
  reportAfter,
  reportStackKey,
  reportStackOrder,
  reportStackTop,
} from "./reportStack.logic";

const report = (id: string, key: string, version: number, createdAt: string, blocking?: true) => ({
  id,
  role: "assistant",
  text: "Report",
  createdAt,
  report: {
    key,
    title: key,
    version,
    question: "Merge?",
    answers: ["Yes", "No"],
    ...(blocking ? { blocking } : {}),
  },
});

const messages = [
  report("deploy-1", "deploy", 1, "2026-11-20T10:00:00.000Z"),
  report("pr-1", "pr:212", 1, "2026-11-21T10:00:00.000Z"),
  report("crash-1", "crash", 1, "2026-11-22T10:00:00.000Z"),
  // A new version of the deploy report keeps the deploy topic first.
  report("deploy-2", "deploy", 2, "2026-11-23T10:00:00.000Z"),
];

const topics = (order: ReadonlyArray<{ message: { report?: { key: string } | undefined } }>) =>
  order.map((entry) => entry.message.report!.key);

describe("report stack order", () => {
  it("keeps each topic where it first arrived and puts Later topics last, in the order put off", () => {
    const reports = coordinatorReports(messages, []);
    expect(topics(reportStackOrder(reports, []))).toEqual(["deploy", "pr:212", "crash"]);
    expect(reportStackOrder(reports, []).map((entry) => entry.message.id)[0]).toBe("deploy-2");
    expect(topics(reportStackOrder(reports, ["deploy", "pr:212"]))).toEqual([
      "crash",
      "deploy",
      "pr:212",
    ]);
    expect(deferReport(["deploy", "pr:212"], "deploy")).toEqual(["pr:212", "deploy"]);
  });

  it("puts blocking reports first and lets a later version set or clear the flag", () => {
    const blockedCrash = [
      ...messages,
      report("crash-2", "crash", 2, "2026-11-24T09:00:00.000Z", true),
    ];
    expect(topics(reportStackOrder(coordinatorReports(blockedCrash, []), []))).toEqual([
      "crash",
      "deploy",
      "pr:212",
    ]);
    // Later still wins over blocking for this visit.
    expect(topics(reportStackOrder(coordinatorReports(blockedCrash, []), ["crash"]))).toEqual([
      "deploy",
      "pr:212",
      "crash",
    ]);
    const cleared = [...blockedCrash, report("crash-3", "crash", 3, "2026-11-24T11:00:00.000Z")];
    expect(topics(reportStackOrder(coordinatorReports(cleared, []), []))).toEqual([
      "deploy",
      "pr:212",
      "crash",
    ]);
  });

  it("moves to the next topic after the top one leaves, wrapping to the first", () => {
    const order = reportStackOrder(coordinatorReports(messages, []), []);
    expect(reportAfter(order, "deploy")).toBe("pr:212");
    expect(reportAfter(order, "crash")).toBe("deploy");
    expect(reportAfter(order.slice(0, 1), "deploy")).toBeNull();
  });

  it("brings a failed answer back in its place without taking the top from the report being read", () => {
    const answered: PendingReportResponse = {
      ref: { messageId: "deploy-2", key: "deploy", version: 2 },
      kind: "answer",
      messageId: "answer-1",
      text: "[deploy, version 2] Yes",
      createdAt: "2026-11-24T10:00:00.000Z",
    };
    const sending = coordinatorReports([...messages, ...pendingReportAnswers([answered])], []);
    const whileSending = reportStackOrder(sending, []);
    expect(topics(whileSending)).toEqual(["pr:212", "crash"]);
    const current = reportAfter(reportStackOrder(coordinatorReports(messages, []), []), "deploy");
    expect(reportStackTop(whileSending, { open: true, current })?.message.report?.key).toBe(
      "pr:212",
    );

    // The send failed: the pending answer is dropped and the report is open again.
    const failed = reportStackOrder(coordinatorReports(messages, []), []);
    expect(topics(failed)).toEqual(["deploy", "pr:212", "crash"]);
    expect(reportStackTop(failed, { open: true, current })?.message.report?.key).toBe("pr:212");
  });

  it("answers once per key press and takes no input while an answer lifts off", () => {
    const order = reportStackOrder(coordinatorReports(messages, []), []);
    const view = openReportStack(closedReportStack, order);
    expect(reportStackKey({ key: "1", repeat: false }, view, ["Yes", "No"])).toEqual({
      kind: "answer",
      answer: "Yes",
    });
    // Holding the key down repeats it; the repeats answer nothing.
    expect(reportStackKey({ key: "1", repeat: true }, view, ["Yes", "No"])).toBeNull();
    expect(reportStackKey({ key: "ArrowRight", repeat: true }, view, [])).toBeNull();

    const lifting = answerReportStack(view, order, order[0]!, "Yes", true)!;
    expect(lifting.current).toBe("pr:212");
    expect(reportStackKey({ key: "1", repeat: false }, lifting, ["Yes", "No"])).toBeNull();
    expect(reportStackKey({ key: "ArrowRight", repeat: false }, lifting, [])).toBeNull();
    // A click on the next sheet's answer is refused too, until the answered sheet has landed.
    expect(answerReportStack(lifting, order.slice(1), order[1]!, "Yes", true)).toBeNull();
    expect(deferReportStack(lifting, order.slice(1), order[1]!)).toBeNull();
    // Esc still leaves.
    expect(reportStackKey({ key: "Escape", repeat: false }, lifting, [])).toEqual({
      kind: "close",
    });

    const landed = landReportStack(lifting, lifting.lift);
    expect(answerReportStack(landed, order.slice(1), order[1]!, "Yes", true)?.current).toBe(
      "crash",
    );
  });

  it("keeps the open sheet when a new report or a new version of an older one arrives", () => {
    const first = reportStackOrder(coordinatorReports(messages.slice(0, 3), []), []);
    const reading = { ...openReportStack(closedReportStack, first), current: "pr:212" };
    const arrived = reportStackOrder(
      coordinatorReports(
        [
          ...messages.slice(0, 3),
          report("tags-1", "tags", 1, "2026-11-19T10:00:00.000Z"),
          report("deploy-2", "deploy", 2, "2026-11-24T10:00:00.000Z"),
        ],
        [],
      ),
      [],
    );
    expect(topics(arrived)[0]).toBe("tags");
    expect(reportStackTop(arrived, reading)?.message.report?.key).toBe("pr:212");
    // A new version of the topic being read replaces its sheet in place.
    const updated = reportStackOrder(
      coordinatorReports(
        [...messages.slice(0, 3), report("pr-2", "pr:212", 2, "2026-11-24T10:00:00.000Z")],
        [],
      ),
      [],
    );
    expect(reportStackTop(updated, reading)?.message.id).toBe("pr-2");
  });

  it("shows the first report in order on the closed pile after one was picked", () => {
    const order = reportStackOrder(coordinatorReports(messages, []), []);
    const picked = { ...openReportStack(closedReportStack, order), current: "crash" };
    expect(reportStackTop(order, picked)?.message.report?.key).toBe("crash");
    const closed = closeReportStack(picked);
    expect(reportStackTop(order, closed)?.message.report?.key).toBe("deploy");
    // Reopening starts from what the pile showed.
    expect(openReportStack(closed, order).current).toBe("deploy");
  });

  it("does not let a stale landing clear a newer lift on the same report", () => {
    const order = reportStackOrder(coordinatorReports(messages, []), []);
    const first = answerReportStack(
      openReportStack(closedReportStack, order),
      order,
      order[0]!,
      "Yes",
      true,
    )!;
    // The send failed, the stack was closed and reopened, and the same report answered again.
    const retried = answerReportStack(
      openReportStack(closeReportStack(first), order),
      order,
      order[0]!,
      "Yes",
      true,
    )!;
    expect(retried.lift).toBe(first.lift + 1);
    expect(landReportStack(retried, first.lift)).toBe(retried);
    expect(landReportStack(retried, retried.lift).leaving).toBeNull();
  });

  it("keeps a picked report off the closed pile's top and the open sheet when a blocking report arrives", () => {
    const blocked = [...messages, report("crash-2", "crash", 2, "2026-11-24T09:00:00.000Z", true)];
    const order = reportStackOrder(coordinatorReports(blocked, []), []);
    const picked = { ...openReportStack(closedReportStack, order), current: "pr:212" };
    expect(reportStackTop(order, picked)?.message.report?.key).toBe("pr:212");
    expect(reportStackTop(order, closeReportStack(picked))?.message.report?.key).toBe("crash");

    // Reading the deploy report when the crash report becomes blocking: the deploy report stays.
    const reading = openReportStack(
      closedReportStack,
      reportStackOrder(coordinatorReports(messages, []), []),
    );
    expect(reading.current).toBe("deploy");
    expect(reportStackTop(order, reading)?.message.report?.key).toBe("deploy");
  });
});
