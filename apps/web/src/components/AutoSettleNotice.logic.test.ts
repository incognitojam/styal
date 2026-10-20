import { describe, expect, it } from "vite-plus/test";

import { type AutoSettleNoticeThread, resolveAutoSettleNotice } from "./AutoSettleNotice.logic.ts";

const SINCE = "2026-10-20T10:00:00.000Z";
const merged = {
  kind: "pull_request",
  state: "merged",
  number: 123,
  url: "https://example.test/owner/repository/pull/123",
} as const;

const thread = (overrides: Partial<AutoSettleNoticeThread> = {}): AutoSettleNoticeThread => ({
  title: "Fix the build",
  archivedAt: null,
  settledOverride: "settled",
  settleReason: merged,
  updatedAt: "2026-10-20T11:00:00.000Z",
  lineage: { relationshipToParent: null },
  ...overrides,
});

describe("resolveAutoSettleNotice", () => {
  it("explains a single automatic settle with its reason", () => {
    const settled = thread();
    expect(
      resolveAutoSettleNotice({
        threads: [settled, thread({ settledOverride: null })],
        since: SINCE,
        dismissed: false,
      }),
    ).toEqual({ kind: "single", thread: settled, reason: merged });
  });

  it("combines several automatic settles into one notice", () => {
    const idle = thread({ title: "Idle", settleReason: { kind: "inactivity", days: 3 } });
    const notice = resolveAutoSettleNotice({
      threads: [thread(), idle],
      since: SINCE,
      dismissed: false,
    });
    expect(notice?.kind).toBe("combined");
    expect(notice?.kind === "combined" ? notice.threads : []).toHaveLength(2);
  });

  it("ignores settles from before this device first ran the notice", () => {
    expect(
      resolveAutoSettleNotice({
        threads: [thread({ updatedAt: "2026-10-20T09:59:59.000Z" })],
        since: SINCE,
        dismissed: false,
      }),
    ).toBeNull();
    // No first-run timestamp yet: nothing to explain.
    expect(
      resolveAutoSettleNotice({ threads: [thread()], since: null, dismissed: false }),
    ).toBeNull();
  });

  it("ignores explicit settles, unrecorded reasons, archived threads and subagents", () => {
    expect(
      resolveAutoSettleNotice({
        threads: [
          thread({ settleReason: { kind: "user" } }),
          thread({ settleReason: null }),
          thread({ settleReason: undefined }),
          thread({ archivedAt: "2026-10-20T12:00:00.000Z" }),
          thread({ lineage: { relationshipToParent: "subagent" } }),
        ],
        since: SINCE,
        dismissed: false,
      }),
    ).toBeNull();
  });

  it("never shows again once dismissed", () => {
    expect(
      resolveAutoSettleNotice({ threads: [thread()], since: SINCE, dismissed: true }),
    ).toBeNull();
  });
});
