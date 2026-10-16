import { describe, expect, it } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";

import { type ServerUpdateHost, serverUpdateConfirmation } from "./ServerUpdateAction.logic";

const idle = {
  activeSessions: 0,
  continuableSessions: 0,
  waitingSessions: 0,
  terminalsRequiringConfirmation: 0,
  terminalsWithUnknownActivity: 0,
  environmentsUsingDevices: 0,
};

function confirmation(overrides: Partial<ServerUpdateHost> = {}): string | null {
  return serverUpdateConfirmation([host(overrides)])?.message ?? null;
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

function messageForHosts(hosts: ReadonlyArray<ServerUpdateHost>): string | null {
  return serverUpdateConfirmation(hosts)?.message ?? null;
}

describe("serverUpdateConfirmation", () => {
  it("names threads on each server and only promises continuation where requested", () => {
    const activity = {
      ...idle,
      activeSessions: 1,
      continuableSessions: 1,
      threads: [
        {
          threadId: ThreadId.make("release"),
          title: "Check the release",
          reasons: ["running" as const],
          continuable: true,
        },
      ],
    };
    const message = serverUpdateConfirmation([
      host({ serverLabel: "Laptop", activity, continueRunningThreads: true }),
      host({ serverLabel: "Lab server", activity, continueRunningThreads: false }),
    ]);
    expect(message?.message).toContain("1 thread will continue after the restart.");
    expect(message?.threadActivity).toEqual([
      { thread: activity.threads[0], hostLabel: "Laptop", continuesAfterRestart: true },
      { thread: activity.threads[0], hostLabel: "Lab server", continuesAfterRestart: false },
    ]);
  });

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
        "2 threads and 1 terminal session will be interrupted.",
        "",
        "Thread names and activity reasons are unavailable from this server.",
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
        "",
        "Thread names and activity reasons are unavailable from this server.",
      ].join("\n"),
    );
  });

  it("asks when activity could not be checked", () => {
    expect(confirmation({ activity: null })).toBe(
      [
        "Update the Lab server?",
        "Could not check the Lab server for running work.",
        "Running threads and terminals may be interrupted.",
      ].join("\n"),
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
      messageForHosts([
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
        "",
        "Thread names and activity reasons are unavailable for Laptop.",
        "Thread names and activity reasons are unavailable for Office.",
      ].join("\n"),
    );
  });

  it("names the desktop apps and unchecked servers in a batch", () => {
    expect(
      messageForHosts([
        host({ serverLabel: "Laptop", desktopApp: true }),
        host({ serverLabel: "Office", desktopApp: true, activity: null }),
      ]),
    ).toBe(
      [
        "Update the styal desktop apps on Laptop, Office?",
        "They will close and relaunch on those machines.",
        "Could not check Office for running work.",
      ].join("\n"),
    );
  });

  it("names every server when a batch mixes desktop apps and plain servers", () => {
    expect(
      messageForHosts([
        host({ serverLabel: "Laptop", desktopApp: true }),
        host({ serverLabel: "Office", activity: { ...idle, activeSessions: 1, threads: [] } }),
      ]),
    ).toBe(
      [
        "Update the servers on Laptop, Office?",
        "The styal desktop app on Laptop will close and relaunch.",
        "1 thread will be interrupted.",
      ].join("\n"),
    );
  });

  it("does not ask when every server in a batch is idle", () => {
    expect(
      messageForHosts([host({ serverLabel: "Laptop" }), host({ serverLabel: "Office" })]),
    ).toBeNull();
  });
});
