import { describe, expect, it } from "vite-plus/test";

import { settleReasonLabel, settleReasonSentence } from "./threadSettleReason.ts";

describe("settle reason labels", () => {
  it("labels automatic settles and leaves explicit ones unlabeled", () => {
    const merged = { kind: "pull_request", state: "merged", number: 123, url: "u" } as const;
    expect(settleReasonLabel(merged)).toBe("PR #123 merged");
    expect(settleReasonSentence({ ...merged, state: "closed" })).toBe("because PR #123 closed");
    expect(settleReasonLabel({ kind: "inactivity", days: 3 })).toBe("Idle 3 days");
    expect(settleReasonLabel({ kind: "inactivity", days: 1 })).toBe("Idle 1 day");
    expect(settleReasonSentence({ kind: "inactivity", days: 3 })).toBe(
      "after 3 days without activity",
    );
    expect(settleReasonLabel({ kind: "user" })).toBeNull();
    expect(settleReasonLabel(null)).toBeNull();
    expect(settleReasonSentence(undefined)).toBeNull();
  });
});
