import { describe, expect, it } from "vite-plus/test";
import { ThreadId, summarizeDesktopUpdateActivity } from "@t3tools/contracts";

import {
  type ServerUpdateHost,
  serverUpdateActivity,
  serverUpdateConfirmation,
  serverUpdateQuestion,
} from "./ServerUpdateAction.logic";

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
    desktopActivity: [
      overrides.activity === null
        ? null
        : {
            ...summarizeDesktopUpdateActivity(overrides.activity ?? idle),
            isRequestingEnvironment: true,
          },
    ],
    desktopApp: false,
    continueRunningThreads: false,
    ...overrides,
  };
}

function messageForHosts(hosts: ReadonlyArray<ServerUpdateHost>): string | null {
  return serverUpdateConfirmation(hosts)?.message ?? null;
}

describe("serverUpdateConfirmation", () => {
  it("skips confirmation for mixed hosts only when each running turn will resume", () => {
    const hosts = [
      host({ desktopApp: true }),
      host({
        serverLabel: "Build server",
        activity: { ...idle, activeSessions: 2, continuableSessions: 2 },
        continueRunningThreads: true,
      }),
    ];
    expect(serverUpdateConfirmation(hosts)).toBeNull();
    expect(
      serverUpdateConfirmation([hosts[0]!, { ...hosts[1]!, continueRunningThreads: false }]),
    ).not.toBeNull();
  });

  it.each([
    { name: "waiting requests or secrets", activity: { ...idle, waitingSessions: 1 } },
    { name: "non-continuable turns", activity: { ...idle, activeSessions: 1 } },
    { name: "terminal commands", activity: { ...idle, terminalsRequiringConfirmation: 1 } },
    {
      name: "unknown terminal activity",
      activity: { ...idle, terminalsRequiringConfirmation: 1, terminalsWithUnknownActivity: 1 },
    },
    { name: "provider installs", activity: { ...idle, providerInstalls: 1 } },
    { name: "shared devices", activity: { ...idle, environmentsUsingDevices: 1 } },
    { name: "failed host checks", activity: null },
  ])("keeps confirmation for $name beside safe hosts", ({ activity }) => {
    const confirmation = serverUpdateConfirmation([
      host({
        serverLabel: "Safe server",
        activity: { ...idle, activeSessions: 1, continuableSessions: 1 },
        continueRunningThreads: true,
      }),
      host({ serverLabel: "Other server", activity, continueRunningThreads: true }),
    ]);
    expect(confirmation).not.toBeNull();
    expect(confirmation!.message).toContain("Safe server, Other server");
  });

  it("retains safe hosts' thread rows even when they need no standalone confirmation", () => {
    const thread = {
      threadId: ThreadId.make("resumes"),
      title: "Prepare release",
      reasons: ["running" as const],
      continuable: true,
    };
    const safe = host({
      serverLabel: "Build server",
      activity: { ...idle, activeSessions: 1, continuableSessions: 1, threads: [thread] },
      continueRunningThreads: true,
    });
    const rows = [{ thread, hostLabel: "Build server", continuesAfterRestart: true }];
    expect(serverUpdateConfirmation([safe, host()])).toBeNull();
    expect(serverUpdateActivity([safe, host()]).threadActivity).toEqual(rows);
    expect(serverUpdateConfirmation([safe, host({ activity: null })])?.threadActivity).toEqual(
      rows,
    );
  });

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
    expect(message?.message).not.toMatch(/\d+ threads? will (be interrupted|continue)/);
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

  it("names a machine-labelled server from a batch update as a server", () => {
    // Batch updates label each target with the machine name alone.
    expect(confirmation({ serverLabel: "build-box", activity: null })).toBe(
      [
        "Update the build-box server?",
        "Could not check the build-box server for running work.",
        "Running threads and terminals may be interrupted.",
      ].join("\n"),
    );
    expect(
      confirmation({ serverLabel: "build-box", desktopApp: true, activity: null })?.split("\n")[0],
    ).toBe("Update the styal desktop app that runs the build-box server?");
    expect(serverUpdateQuestion([host({ serverLabel: "server" })])).toBe("Update the server?");
  });

  it("skips an idle remote desktop restart and asks when work would be interrupted", () => {
    expect(confirmation({ desktopApp: true })).toBeNull();
    expect(confirmation({ desktopApp: true, activity: { ...idle, activeSessions: 1 } })).toContain(
      "1 thread will be interrupted.",
    );
  });

  it.each([
    [host({ desktopApp: true })],
    [
      host({ serverLabel: "Laptop", desktopApp: true }),
      host({ serverLabel: "Office", desktopApp: true }),
    ],
    [host({ serverLabel: "Laptop", desktopApp: true }), host({ serverLabel: "Office" })],
  ])("keeps the desktop update title while checking running work: %j", (...hosts) => {
    expect(
      serverUpdateConfirmation(
        hosts.map((host) => ({ ...host, activity: null, desktopActivity: null })),
      )?.message.split("\n")[0],
    ).toBe(serverUpdateQuestion(hosts));
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
