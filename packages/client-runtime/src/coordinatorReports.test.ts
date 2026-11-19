import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import { describe, expect, it } from "vite-plus/test";
import {
  coordinatorReports,
  formatReportAnswer,
  reportAnswerDisplay,
  reportReplyReference,
  splitReportAnswer,
  waitingCoordinatorReports,
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

  it("keeps the question open after a comment and shows the latest answer", () => {
    const ref = { messageId: "a", key: "pr:1", version: 1 };
    const quote = serializeAssistantCitation({
      version: 1,
      environmentId: EnvironmentId.make("env"),
      threadId: ThreadId.make("thread"),
      messageId: MessageId.make("a"),
      text: "Tests passed",
      start: 0,
      end: 12,
      prefix: "",
      suffix: "",
      comment: "Which tests?",
    });
    const reply = (id: string, text: string) => ({
      id,
      role: "user",
      text: formatReportAnswer({ title: "pr:1", version: 1 }, text),
      createdAt: id,
      reportAnswer: reportReplyReference(ref, text),
    });
    const states = (...replies: ReturnType<typeof reply>[]) =>
      coordinatorReports([{ ...report("a", "pr:1", 1), createdAt: "0" }, ...replies], []);

    const commented = states(reply("1", ` ${quote} `));
    expect(commented[0]?.state).toBe("open");
    expect(waitingCoordinatorReports(commented)).toHaveLength(1);
    expect(reportReplyReference(ref, `${quote} Merge it`)).toEqual(ref);

    const answered = states(reply("1", quote), reply("2", "Hold"), reply("3", "Merge it"));
    expect(answered[0]?.state).toBe("answered");
    expect(answered[0]?.answer?.id).toBe("3");
    expect(waitingCoordinatorReports(answered)).toHaveLength(0);
    expect(states(reply("2", "Hold"), reply("3", quote))[0]?.answer?.id).toBe("2");
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
