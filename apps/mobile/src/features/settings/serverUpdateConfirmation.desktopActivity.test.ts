import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  summarizeDesktopUpdateActivity,
  type HostActivity,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { describeServerUpdate } from "./serverUpdateConfirmation";

const idle: HostActivity = {
  activeSessions: 0,
  continuableSessions: 0,
  waitingSessions: 0,
  terminalsRequiringConfirmation: 0,
  terminalsWithUnknownActivity: 0,
  environmentsUsingDevices: 0,
};

describe("remote desktop update pool confirmation", () => {
  it("retains selected thread details beside anonymous sibling counts without double counting", () => {
    const selected: HostActivity = {
      ...idle,
      environmentId: EnvironmentId.make("selected-environment"),
      activeSessions: 1,
      continuableSessions: 1,
      terminalsRequiringConfirmation: 1,
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
    const confirmation = describeServerUpdate({
      serverLabel: "Desktop host",
      targetVersion: "1.2.4",
      desktopManaged: true,
      continueRunningThreads: true,
      activity: selected,
      desktopActivity: [
        {
          ...summarizeDesktopUpdateActivity(idle),
          isRequestingEnvironment: false,
          terminalsRequiringConfirmation: 1,
        },
        { ...summarizeDesktopUpdateActivity(selected), isRequestingEnvironment: true },
      ],
    });
    expect(confirmation.threadActivity).toEqual([
      {
        thread: selected.threads![0],
        environmentId: selected.environmentId,
        hostLabel: null,
        continuesAfterRestart: true,
      },
    ]);
    expect(confirmation.message).toContain("2 terminal sessions will be interrupted.");
  });
});
