import { describe, expect, it } from "vite-plus/test";

import { serverUpdateConfirmation } from "./ServerUpdateAction.logic";

const idle = {
  activeSessions: 0,
  waitingSessions: 0,
  terminalsRequiringConfirmation: 0,
  terminalsWithUnknownActivity: 0,
};

function confirmation(
  overrides: Partial<Parameters<typeof serverUpdateConfirmation>[0]> = {},
): string | null {
  return serverUpdateConfirmation({
    serverLabel: "Lab server",
    activity: idle,
    desktopApp: false,
    continueRunningThreads: false,
    ...overrides,
  });
}

describe("serverUpdateConfirmation", () => {
  it("does not ask when the server is idle", () => {
    expect(confirmation()).toBeNull();
  });

  it("lists running threads and terminals that the restart interrupts", () => {
    expect(
      confirmation({
        activity: { ...idle, activeSessions: 2, terminalsRequiringConfirmation: 1 },
      }),
    ).toBe(
      [
        "Update the Lab server with running work?",
        "2 threads will be interrupted.",
        "1 terminal session will be interrupted.",
        "The server restarts to finish the update.",
      ].join("\n"),
    );
  });

  it("asks when activity could not be checked", () => {
    expect(confirmation({ activity: null })).toMatch(
      /^Update the Lab server without checking activity\?\nActivity could not be checked on the Lab server\./,
    );
  });

  it("always asks before relaunching a remote desktop app", () => {
    expect(confirmation({ desktopApp: true })).toBe(
      "Update the desktop app that runs the Lab server?\nIt will close and relaunch on that machine.",
    );
    expect(confirmation({ desktopApp: true, activity: { ...idle, activeSessions: 1 } })).toContain(
      "1 thread will be interrupted.",
    );
  });
});
