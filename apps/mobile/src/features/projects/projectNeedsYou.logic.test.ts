import type { ThreadPendingUserInput } from "@t3tools/client-runtime/state/thread-requests";
import { describe, expect, it } from "vite-plus/test";

import { oldestFirst, oneTapQuestion } from "./projectNeedsYou.logic";

describe("oldestFirst", () => {
  it("orders reviews, the chat's reports and other threads' needs together by time", () => {
    const rows = [
      { key: "review", at: "2026-11-19T09:30:00.000Z" },
      { key: "chat-report", at: "2026-11-19T09:10:00.000Z" },
      { key: "question-b", at: "2026-11-19T09:00:00.000Z" },
      { key: "question-a", at: "2026-11-19T09:00:00.000Z" },
    ];
    expect(
      oldestFirst(
        rows,
        (row) => row.at,
        (row) => row.key,
      ).map((row) => row.key),
    ).toEqual(["question-a", "question-b", "chat-report", "review"]);
  });
});

describe("oneTapQuestion", () => {
  const option = { label: "Yes", description: "Yes" };
  const input = (questions: ReadonlyArray<Record<string, unknown>>) =>
    ({ questions }) as unknown as ThreadPendingUserInput;
  const question = { id: "q1", header: "Pick", question: "Which?", options: [option] };

  it("answers only a single single-select question that has options", () => {
    expect(oneTapQuestion(input([question]))).toMatchObject({ id: "q1" });
    // Several selections, several questions or a free answer need the thread itself.
    expect(oneTapQuestion(input([{ ...question, multiSelect: true }]))).toBeNull();
    expect(oneTapQuestion(input([question, { ...question, id: "q2" }]))).toBeNull();
    expect(oneTapQuestion(input([{ ...question, options: [] }]))).toBeNull();
  });
});
