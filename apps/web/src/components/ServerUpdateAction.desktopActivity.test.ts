import {
  DesktopUpdateActivityReport,
  EnvironmentId,
  ThreadId,
  ProjectId,
  summarizeDesktopUpdateActivity,
  type DesktopUpdateActivity,
  type HostActivity,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  serverUpdateActivity,
  serverUpdateConfirmation,
  type ServerUpdateHost,
} from "./ServerUpdateAction.logic";

const idle: DesktopUpdateActivity = {
  activeSessions: 0,
  continuableSessions: 0,
  waitingSessions: 0,
  terminalsRequiringConfirmation: 0,
  terminalsWithUnknownActivity: 0,
  environmentsUsingDevices: 0,
};
const target: ServerUpdateHost = {
  serverLabel: "Desktop host",
  desktopApp: true,
  continueRunningThreads: true,
  activity: idle,
};
const resumable: HostActivity = {
  ...idle,
  environmentId: EnvironmentId.make("selected-environment"),
  activeSessions: 1,
  continuableSessions: 1,
  threads: [
    {
      threadId: ThreadId.make("resumable"),
      title: "Synthetic task",
      reasons: ["running"],
      continuable: true,
      project: {
        id: ProjectId.make("selected-project"),
        title: "Synthetic project",
        workspaceRoot: "/synthetic/project",
        faviconPath: null,
        projectIcon: null,
      },
    },
  ],
};

const wire = Schema.fromJsonString(DesktopUpdateActivityReport);
const encodePool = Schema.encodeSync(wire);
const decodePool = Schema.decodeSync(wire);

// The production desktop summary and telemetry schema both remove thread details.
function wirePool(primary: HostActivity = idle, sibling: DesktopUpdateActivity | null = idle) {
  const report = {
    version: 1 as const,
    type: "desktopUpdateActivity" as const,
    requestId: "check",
    hosts: [
      { ...summarizeDesktopUpdateActivity(primary), isRequestingEnvironment: true },
      sibling && { ...sibling, isRequestingEnvironment: false },
    ],
  };
  return decodePool(encodePool(report)).hosts;
}

describe("remote desktop update activity", () => {
  it("retains selected thread and project details beside anonymous sibling counts without double counting", () => {
    const primary = { ...resumable, terminalsRequiringConfirmation: 1 };
    const desktopActivity = wirePool(primary, {
      ...idle,
      activeSessions: 1,
      continuableSessions: 1,
      terminalsRequiringConfirmation: 1,
    }).toReversed();
    expect(desktopActivity[1]).not.toHaveProperty("threads");
    const hosts = [{ ...target, activity: primary, desktopActivity }];
    const activity = serverUpdateActivity(hosts);
    expect(activity.threadActivity).toEqual([
      {
        thread: primary.threads![0],
        environmentId: primary.environmentId,
        hostLabel: null,
        continuesAfterRestart: true,
      },
    ]);
    expect(activity.lines).toContain("2 terminal sessions will be interrupted.");
    expect(activity.lines).toContain("1 thread will continue after the restart.");
    expect(activity.lines).toContain(
      "Thread names and activity reasons are unavailable for other environments on this desktop app.",
    );
    expect(serverUpdateConfirmation(hosts)?.threadActivity).toEqual(activity.threadActivity);
  });

  it("still confirms when the selected thread and every sibling are resumable", () => {
    const hosts = [
      {
        ...target,
        activity: resumable,
        desktopActivity: wirePool(resumable, {
          ...idle,
          activeSessions: 1,
          continuableSessions: 1,
        }),
      },
    ];
    expect(serverUpdateConfirmation(hosts)).not.toBeNull();
    expect(serverUpdateActivity(hosts).threadActivity).toHaveLength(1);
  });

  it.each([
    ["legacy host", undefined],
    ["failed request", null],
    ["empty coverage", []],
    ["failed sibling", wirePool(resumable, null)],
    ["legacy counts without a primary marker", [summarizeDesktopUpdateActivity(resumable), idle]],
    ["missing primary", [{ ...idle, isRequestingEnvironment: false }]],
    [
      "ambiguous primary",
      [
        { ...idle, isRequestingEnvironment: true },
        { ...idle, isRequestingEnvironment: true },
      ],
    ],
  ] as const)(
    "asks with %s while retaining the selected thread details",
    (_name, desktopActivity) => {
      const hosts = [
        {
          ...target,
          activity: resumable,
          ...(desktopActivity === undefined ? {} : { desktopActivity }),
        },
      ];
      expect(serverUpdateActivity(hosts)).toMatchObject({ interrupts: true, incomplete: true });
      expect(serverUpdateConfirmation(hosts)?.message).toContain("Could not check");
      expect(serverUpdateConfirmation(hosts)?.threadActivity).toMatchObject([
        { thread: resumable.threads![0], continuesAfterRestart: true },
      ]);
    },
  );

  it("requires confirmation when the primary check fails even if all pool counts are safe", () => {
    expect(
      serverUpdateActivity([{ ...target, activity: null, desktopActivity: wirePool() }]),
    ).toMatchObject({ interrupts: true, incomplete: true });
  });

  it("retains known sibling warnings when the desktop cannot identify the primary", () => {
    const hosts = [
      {
        ...target,
        activity: resumable,
        desktopActivity: [
          null,
          {
            ...idle,
            isRequestingEnvironment: false,
            terminalsRequiringConfirmation: 1,
            providerInstalls: 1,
            environmentsUsingDevices: 1,
          },
        ],
      },
    ];
    const activity = serverUpdateActivity(hosts);
    expect(activity).toMatchObject({ interrupts: true, incomplete: true });
    expect(activity.threadActivity).toHaveLength(1);
    expect(activity.lines).toEqual(
      expect.arrayContaining([
        "1 terminal session will be interrupted.",
        "A provider update is installing and will be interrupted.",
        "Devices in use by other environments will be disconnected.",
      ]),
    );
    expect(serverUpdateConfirmation(hosts)?.message).toContain("Could not check");
  });

  it("uses the selected report rather than its duplicate pool snapshot", () => {
    const hosts = [
      { ...target, activity: { ...idle, waitingSessions: 1 }, desktopActivity: wirePool() },
    ];
    expect(serverUpdateActivity(hosts).lines).toContain("1 thread will be interrupted.");
    expect(serverUpdateConfirmation(hosts)).not.toBeNull();
  });

  it("retains failed desktop coverage in a batch beside a safe standalone server", () => {
    const activity = serverUpdateActivity([
      target,
      { ...target, serverLabel: "CLI host", desktopApp: false },
    ]);
    expect(activity).toMatchObject({ incomplete: true, interrupts: true });
    expect(activity.lines).toContain("Could not check Desktop host for running work.");
  });
});
