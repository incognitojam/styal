import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  summarizeDesktopUpdateActivity,
  type DesktopUpdateActivity,
  type HostActivity,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  serverUpdateActivity,
  serverUpdateConfirmation,
  type ServerUpdateHost,
} from "./ServerUpdateAction.logic";

const idle: HostActivity = {
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

const selectedEntry = (activity: HostActivity): DesktopUpdateActivity => ({
  ...summarizeDesktopUpdateActivity(activity),
  isRequestingEnvironment: true,
});
const sibling = (counts: Partial<HostActivity> = {}): DesktopUpdateActivity => ({
  ...summarizeDesktopUpdateActivity({ ...idle, ...counts }),
  isRequestingEnvironment: false,
});

describe("remote desktop update activity", () => {
  it("retains selected thread details beside anonymous sibling counts without double counting", () => {
    const selected = { ...resumable, terminalsRequiringConfirmation: 1 };
    const hosts = [
      {
        ...target,
        activity: selected,
        desktopActivity: [
          sibling({ activeSessions: 1, continuableSessions: 1, terminalsRequiringConfirmation: 1 }),
          selectedEntry(selected),
        ],
      },
    ];
    const activity = serverUpdateActivity(hosts);
    expect(activity.threadActivity).toEqual([
      {
        thread: selected.threads![0],
        environmentId: selected.environmentId,
        hostLabel: null,
        continuesAfterRestart: true,
      },
    ]);
    expect(activity.lines).toContain("2 terminal sessions will be interrupted.");
    expect(activity.lines).toContain("1 thread will continue after the restart.");
    expect(serverUpdateConfirmation(hosts)?.threadActivity).toEqual(activity.threadActivity);
  });

  it("explains missing sibling thread names once for several busy siblings", () => {
    const busy = sibling({ waitingSessions: 1 });
    const { lines } = serverUpdateActivity([
      { ...target, desktopActivity: [selectedEntry(idle), busy, busy] },
    ]);
    expect(lines.filter((line) => line.startsWith("Thread names"))).toEqual([
      "Thread names and activity reasons are unavailable for other environments on this desktop app.",
    ]);
  });

  it.each([
    ["no pool report", null],
    ["a failed sibling", [selectedEntry(resumable), null]],
    ["no selected entry", [sibling()]],
    ["two selected entries", [selectedEntry(idle), selectedEntry(idle)]],
  ] as const)(
    "asks with %s while retaining the selected thread details",
    (_name, desktopActivity) => {
      const hosts = [{ ...target, activity: resumable, desktopActivity }];
      expect(serverUpdateActivity(hosts)).toMatchObject({ interrupts: true, incomplete: true });
      expect(serverUpdateConfirmation(hosts)?.message).toContain("Could not check");
      expect(serverUpdateConfirmation(hosts)?.threadActivity).toMatchObject([
        { thread: resumable.threads![0], continuesAfterRestart: true },
      ]);
    },
  );

  it("retains known sibling warnings when the desktop cannot identify the selected environment", () => {
    const activity = serverUpdateActivity([
      {
        ...target,
        activity: resumable,
        desktopActivity: [
          null,
          sibling({ terminalsRequiringConfirmation: 1, providerInstalls: 1 }),
        ],
      },
    ]);
    expect(activity).toMatchObject({ interrupts: true, incomplete: true });
    expect(activity.threadActivity).toHaveLength(1);
    expect(activity.lines).toEqual(
      expect.arrayContaining([
        "1 terminal session will be interrupted.",
        "A provider update is installing and will be interrupted.",
      ]),
    );
  });

  it("uses the selected environment's own report rather than its pool entry", () => {
    const hosts = [
      {
        ...target,
        activity: { ...idle, waitingSessions: 1 },
        desktopActivity: [selectedEntry(idle), sibling()],
      },
    ];
    expect(serverUpdateActivity(hosts).lines).toContain("1 thread will be interrupted.");
  });
});
