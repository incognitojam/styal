import { describe, expect, it } from "vite-plus/test";
import { resolveThreadActivityState } from "./threadSync";

const running = {
  runtime: { status: "running" as const },
  hasPendingApprovals: false,
  hasPendingUserInput: false,
};
const input = {
  detailStatus: "cached" as const,
  detailServerSequence: undefined as number | undefined,
  shellStatus: "live" as const,
  shellSequence: 9,
  shell: running,
};

describe("thread activity authority", () => {
  it.each(["completed", "failed", "interrupted", "cancelled", "idle"] as const)(
    "uses a server-confirmed %s shell over cached detail",
    (status) => {
      expect(
        resolveThreadActivityState({ ...input, shell: { ...running, runtime: { status } } }),
      ).toBe("inactive");
    },
  );
  it("treats server-confirmed input and approval waits as inactive", () => {
    for (const request of ["hasPendingApprovals", "hasPendingUserInput"] as const) {
      expect(resolveThreadActivityState({ ...input, shell: { ...running, [request]: true } })).toBe(
        "inactive",
      );
    }
  });
  it("does not trust cached or synchronizing summaries, or a missing summary", () => {
    for (const shellStatus of ["cached", "synchronizing", "empty"] as const) {
      expect(
        resolveThreadActivityState({ ...input, shellStatus, shell: { ...running, runtime: null } }),
      ).toBe("unconfirmed");
    }
    expect(resolveThreadActivityState({ ...input, shell: null })).toBe("unconfirmed");
    expect(resolveThreadActivityState(input)).toBe("unconfirmed");
  });
  it("uses the newer server stream when both have synchronized", () => {
    const shell = { ...running, runtime: { status: "completed" as const } };
    expect(
      resolveThreadActivityState({
        ...input,
        detailStatus: "live",
        detailServerSequence: 10,
        shell,
      }),
    ).toBe("live");
    expect(
      resolveThreadActivityState({
        ...input,
        detailStatus: "synchronizing",
        detailServerSequence: 10,
        shell,
      }),
    ).toBe("unconfirmed");
    expect(
      resolveThreadActivityState({
        ...input,
        detailStatus: "live",
        detailServerSequence: 9,
        shell,
      }),
    ).toBe("live");
    expect(
      resolveThreadActivityState({
        ...input,
        detailStatus: "live",
        detailServerSequence: 8,
        shell,
      }),
    ).toBe("inactive");
    expect(
      resolveThreadActivityState({
        ...input,
        detailStatus: "live",
        detailServerSequence: 8,
        shellStatus: "cached",
        shell,
      }),
    ).toBe("live");
    expect(
      resolveThreadActivityState({ ...input, detailStatus: "live", shellSequence: 1, shell }),
    ).toBe("inactive");
  });
});
