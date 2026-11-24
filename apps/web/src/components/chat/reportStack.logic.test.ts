import { describe, expect, it } from "vite-plus/test";
import {
  coordinatorReports,
  pendingReportAnswers,
  type PendingReportResponse,
} from "@t3tools/client-runtime/coordinator-reports";

import { deferReport, reportAfter, reportStackOrder, reportStackTop } from "./reportStack.logic";

const report = (id: string, key: string, version: number, createdAt: string) => ({
  id,
  role: "assistant",
  text: "Report",
  createdAt,
  report: { key, title: key, version, question: "Merge?", answers: ["Yes", "No"] },
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
    expect(reportStackTop(whileSending, current)?.message.report?.key).toBe("pr:212");

    // The send failed: the pending answer is dropped and the report is open again.
    const failed = reportStackOrder(coordinatorReports(messages, []), []);
    expect(topics(failed)).toEqual(["deploy", "pr:212", "crash"]);
    expect(reportStackTop(failed, current)?.message.report?.key).toBe("pr:212");
  });
});
