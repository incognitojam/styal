import { describe, expect, it } from "vite-plus/test";

import { describeHostActivity } from "./hostActivity.ts";

const idle = {
  activeSessions: 0,
  waitingSessions: 0,
  terminalsRequiringConfirmation: 0,
  terminalsWithUnknownActivity: 0,
};
const options = { uncheckedHostsLine: "Some hosts could not be checked." };

describe("describeHostActivity", () => {
  it("needs no confirmation when every host is idle", () => {
    expect(describeHostActivity([idle, idle], options)).toEqual({
      concern: null,
      lines: [],
      incomplete: false,
    });
  });

  it("adds up work across hosts", () => {
    expect(
      describeHostActivity(
        [
          { ...idle, activeSessions: 1, terminalsRequiringConfirmation: 1 },
          { ...idle, activeSessions: 1, waitingSessions: 1 },
        ],
        options,
      ),
    ).toEqual({
      concern: "running",
      lines: [
        "2 threads will be interrupted.",
        "1 thread waiting for input or approval will be interrupted.",
        "1 terminal session will be interrupted.",
      ],
      incomplete: false,
    });
  });

  it("reports waiting threads as their own concern", () => {
    expect(describeHostActivity([{ ...idle, waitingSessions: 2 }], options).concern).toBe(
      "waiting",
    );
  });

  it("does not count uninspected terminals as running work", () => {
    expect(
      describeHostActivity(
        [{ ...idle, terminalsRequiringConfirmation: 1, terminalsWithUnknownActivity: 1 }],
        options,
      ),
    ).toEqual({
      concern: "unchecked",
      lines: ["Activity could not be checked for 1 terminal session."],
      incomplete: true,
    });
  });

  it("treats a failed or missing host check as unchecked", () => {
    for (const checks of [[null], []]) {
      expect(describeHostActivity(checks, options)).toEqual({
        concern: "unchecked",
        lines: ["Some hosts could not be checked."],
        incomplete: true,
      });
    }
  });
});
