import { ThreadId, type HostActivityThread } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { describeHostActivity } from "./hostActivity.ts";

const idle = {
  activeSessions: 0,
  continuableSessions: 0,
  waitingSessions: 0,
  terminalsRequiringConfirmation: 0,
  terminalsWithUnknownActivity: 0,
  environmentsUsingDevices: 0,
};
const options = { uncheckedHostsLine: "Some hosts could not be checked." };

describe("describeHostActivity", () => {
  it("needs no confirmation when every host is idle", () => {
    expect(describeHostActivity([idle, idle], options)).toEqual({
      concern: null,
      lines: [],
      incomplete: false,
      threadActivity: [],
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
        "",
        "Thread names and activity reasons are unavailable from this server.",
        "Thread names and activity reasons are unavailable from this server.",
      ],
      incomplete: false,
      threadActivity: [],
    });
  });

  it("reports waiting threads as their own concern", () => {
    expect(describeHostActivity([{ ...idle, waitingSessions: 2 }], options).concern).toBe(
      "waiting",
    );
  });

  it("separates threads that continue from threads that are interrupted", () => {
    const checks = [{ ...idle, activeSessions: 3, continuableSessions: 2 }];
    expect(describeHostActivity(checks, { ...options, continueRunningThreads: true })).toEqual({
      concern: "running",
      lines: [
        "1 thread will be interrupted.",
        "2 threads will continue after the restart.",
        "",
        "Thread names and activity reasons are unavailable from this server.",
      ],
      incomplete: false,
      threadActivity: [],
    });
    expect(describeHostActivity(checks, options).lines).toEqual([
      "3 threads will be interrupted.",
      "",
      "Thread names and activity reasons are unavailable from this server.",
    ]);
  });

  it("treats other environments using shared devices as running work", () => {
    expect(describeHostActivity([{ ...idle, environmentsUsingDevices: 2 }], options)).toEqual({
      concern: "running",
      lines: ["Devices in use by other environments will be disconnected."],
      incomplete: false,
      threadActivity: [],
    });
  });

  it("does not count uninspected terminals as running work", () => {
    expect(
      describeHostActivity(
        [{ ...idle, terminalsRequiringConfirmation: 1, terminalsWithUnknownActivity: 1 }],
        options,
      ),
    ).toEqual({
      concern: "unchecked",
      lines: ["Could not check 1 terminal session for running commands."],
      incomplete: true,
      threadActivity: [],
    });
  });

  it("treats a failed or missing host check as unchecked", () => {
    for (const checks of [[null], []]) {
      expect(describeHostActivity(checks, options)).toEqual({
        concern: "unchecked",
        lines: ["Some hosts could not be checked."],
        incomplete: true,
        threadActivity: [],
      });
    }
  });
});

const namedThread: HostActivityThread = {
  threadId: ThreadId.make("thread"),
  title: "Check the release",
  projectTitle: "Sample project",
  reasons: ["running", "monitor"],
  continuable: true,
};

describe("host thread descriptions", () => {
  it("keeps titles, project and host context separate from summary copy", () => {
    const activity = describeHostActivity(
      [
        {
          ...idle,
          activeSessions: 1,
          continuableSessions: 1,
          hostLabel: "Lab server",
          threads: [namedThread],
        },
      ],
      options,
    );
    expect(activity.lines).toEqual(["1 thread will be interrupted."]);
    expect(activity.threadActivity).toEqual([
      { thread: namedThread, hostLabel: "Lab server", continuesAfterRestart: false },
    ]);
  });
  it("labels continuation per host, including matching thread IDs on different hosts", () => {
    const check = { ...idle, activeSessions: 1, continuableSessions: 1, threads: [namedThread] };
    const activity = describeHostActivity(
      [
        { ...check, hostLabel: "Laptop", continueRunningThreads: true },
        { ...check, hostLabel: "Lab server", continueRunningThreads: false },
      ],
      options,
    );
    expect(activity.lines).toEqual([
      "1 thread will be interrupted.",
      "1 thread will continue after the restart.",
    ]);
    expect(activity.threadActivity).toEqual([
      { thread: namedThread, hostLabel: "Laptop", continuesAfterRestart: true },
      { thread: namedThread, hostLabel: "Lab server", continuesAfterRestart: false },
    ]);
  });
  it("keeps unnamed threads visible when a title or project is unavailable", () => {
    const unnamed = { ...namedThread, title: "", projectTitle: null };
    const activity = describeHostActivity(
      [
        {
          ...idle,
          activeSessions: 1,
          threads: [unnamed],
        },
      ],
      options,
    );
    expect(activity.lines).toEqual(["1 thread will be interrupted."]);
    expect(activity.threadActivity).toEqual([
      { thread: unnamed, hostLabel: null, continuesAfterRestart: false },
    ]);
  });
  it("keeps known thread details alongside failed host inspections", () => {
    const waiting = { ...namedThread, reasons: ["approval" as const], continuable: false };
    const activity = describeHostActivity(
      [
        {
          ...idle,
          waitingSessions: 1,
          threads: [waiting],
        },
        null,
      ],
      options,
    );
    expect(activity.concern).toBe("waiting");
    expect(activity.incomplete).toBe(true);
    expect(activity.lines).toContain("Some hosts could not be checked.");
    expect(activity.threadActivity).toEqual([
      { thread: waiting, hostLabel: null, continuesAfterRestart: false },
    ]);
  });
});
