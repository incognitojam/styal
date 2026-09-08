import { describe, expect, it } from "vite-plus/test";

import { type ServerUpdateHost, serverUpdateConfirmation } from "./ServerUpdateAction.logic";

const idle = {
  activeSessions: 0,
  continuableSessions: 0,
  waitingSessions: 0,
  terminalsRequiringConfirmation: 0,
  terminalsWithUnknownActivity: 0,
};

function confirmation(overrides: Partial<ServerUpdateHost> = {}): string | null {
  return serverUpdateConfirmation([host(overrides)]);
}

function host(overrides: Partial<ServerUpdateHost> = {}): ServerUpdateHost {
  return {
    serverLabel: "Lab server",
    activity: idle,
    desktopApp: false,
    continueRunningThreads: false,
    ...overrides,
  };
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

  it("says which threads continue when continuation is requested", () => {
    expect(
      confirmation({
        activity: { ...idle, activeSessions: 2, continuableSessions: 1 },
        continueRunningThreads: true,
      }),
    ).toBe(
      [
        "Update the Lab server with running work?",
        "1 thread will be interrupted.",
        "1 thread will continue after the restart.",
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
      "Update the styal desktop app that runs the Lab server?\nIt will close and relaunch on that machine.",
    );
    expect(confirmation({ desktopApp: true, activity: { ...idle, activeSessions: 1 } })).toContain(
      "1 thread will be interrupted.",
    );
  });

  it("asks once for several servers and counts continuation per server", () => {
    expect(
      serverUpdateConfirmation([
        host({
          serverLabel: "Laptop",
          activity: { ...idle, activeSessions: 1, continuableSessions: 1 },
          continueRunningThreads: true,
        }),
        host({
          serverLabel: "Office",
          activity: { ...idle, activeSessions: 1, continuableSessions: 1 },
        }),
        host({ serverLabel: "Idle", activity: idle }),
      ]),
    ).toBe(
      [
        "Update the servers on Laptop, Office, Idle with running work?",
        "1 thread will be interrupted.",
        "1 thread will continue after the restart.",
        "The servers restart to finish the update.",
      ].join("\n"),
    );
  });

  it("names the desktop apps and unchecked servers in a batch", () => {
    expect(
      serverUpdateConfirmation([
        host({ serverLabel: "Laptop", desktopApp: true }),
        host({ serverLabel: "Office", desktopApp: true, activity: null }),
      ]),
    ).toBe(
      [
        "Update the styal desktop apps on Laptop, Office?",
        "They will close and relaunch on those machines.",
        "Activity could not be checked on Office.",
      ].join("\n"),
    );
  });

  it("does not ask when every server in a batch is idle", () => {
    expect(
      serverUpdateConfirmation([host({ serverLabel: "Laptop" }), host({ serverLabel: "Office" })]),
    ).toBeNull();
  });
});
