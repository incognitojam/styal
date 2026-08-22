import { beforeEach, describe, expect, it } from "vite-plus/test";

import { type PendingReviewComment, usePullRequestReviewStore } from "./pullRequestReviewStore";

function comment(id: string, body = id): PendingReviewComment {
  return { id, body, path: "src/app.ts", position: { kind: "added", newLine: 1 } };
}

describe("pull request review drafts", () => {
  beforeEach(() => {
    usePullRequestReviewStore.setState({ drafts: {}, summaries: {}, conversationDrafts: {} });
  });

  it("removes only the line comments included in a submitted snapshot", () => {
    const store = usePullRequestReviewStore.getState();
    store.addComment("review-a", comment("submitted"));
    const submittedIds =
      usePullRequestReviewStore.getState().drafts["review-a"]?.map((entry) => entry.id) ?? [];

    usePullRequestReviewStore.getState().addComment("review-a", comment("added-in-flight"));
    usePullRequestReviewStore.getState().removeComments("review-a", submittedIds);

    expect(usePullRequestReviewStore.getState().drafts["review-a"]).toEqual([
      comment("added-in-flight"),
    ]);
  });

  it("keeps summary bodies isolated by review key", () => {
    const store = usePullRequestReviewStore.getState();
    store.setSummary("review-a", "Summary A");
    store.setSummary("review-b", "Summary B");
    store.clearSummary("review-a", "Summary A");

    expect(usePullRequestReviewStore.getState().summaries).toEqual({
      "review-b": "Summary B",
    });
  });

  it("does not clear a summary revised while submission is in flight", () => {
    const store = usePullRequestReviewStore.getState();
    store.setSummary("review-a", "Submitted body");
    usePullRequestReviewStore.getState().setSummary("review-a", "Revised body");
    usePullRequestReviewStore.getState().clearSummary("review-a", "Submitted body");

    expect(usePullRequestReviewStore.getState().summaries["review-a"]).toBe("Revised body");
  });

  it("keeps conversation drafts isolated by pull request", () => {
    usePullRequestReviewStore.getState().setConversationDraft("pr-a", "Draft for A");
    usePullRequestReviewStore.getState().setConversationDraft("pr-b", "Draft for B");

    expect(usePullRequestReviewStore.getState().conversationDrafts).toEqual({
      "pr-a": "Draft for A",
      "pr-b": "Draft for B",
    });
  });

  it("clears only the conversation draft that was posted", () => {
    const store = usePullRequestReviewStore.getState();
    store.setConversationDraft("pr-a", "Submitted body");
    usePullRequestReviewStore.getState().setConversationDraft("pr-a", "Revised body");
    usePullRequestReviewStore.getState().clearConversationDraft("pr-a", "Submitted body");

    expect(usePullRequestReviewStore.getState().conversationDrafts["pr-a"]).toBe("Revised body");

    usePullRequestReviewStore.getState().setConversationDraft("pr-a", "");
    expect(usePullRequestReviewStore.getState().conversationDrafts["pr-a"]).toBeUndefined();
  });
});
