import { describe, expect, it } from "vite-plus/test";

import { oldestFirst } from "./projectNeedsYou.logic";

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
