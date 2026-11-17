import { describe, expect, it } from "vite-plus/test";
import { coordinatorReports, formatReportAnswer, splitReportAnswer } from "./coordinatorReports.ts";
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

  it("splits the answer prefix only when it names the answered version", () => {
    const text = formatReportAnswer({ title: "#1522 cleanup, ready", version: 2 }, "Wait\nfor 88");
    expect(splitReportAnswer(text, { version: 2 })).toEqual({
      title: "#1522 cleanup, ready",
      version: 2,
      text: "Wait\nfor 88",
    });
    expect(splitReportAnswer(text, { version: 1 })).toBeNull();
    expect(splitReportAnswer("Wait for 88", { version: 2 })).toBeNull();
  });
});
