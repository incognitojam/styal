import {
  DesktopUpdateActivityReport,
  ThreadId,
  EnvironmentId,
  ProjectId,
  summarizeDesktopUpdateActivity,
  type DesktopUpdateActivity,
  type HostActivity,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  describeServerUpdate,
  requestServerUpdateConfirmation,
  respondToServerUpdateConfirmation,
} from "./serverUpdateConfirmation";

const idle: DesktopUpdateActivity = {
  activeSessions: 0,
  continuableSessions: 0,
  waitingSessions: 0,
  terminalsRequiringConfirmation: 0,
  terminalsWithUnknownActivity: 0,
  environmentsUsingDevices: 0,
};
const target = {
  serverLabel: "Desktop host",
  targetVersion: "1.2.4",
  desktopManaged: true,
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

describe("remote desktop update pool confirmation", () => {
  it("retains selected thread and project details beside anonymous sibling counts without double counting", async () => {
    const primary = { ...resumable, terminalsRequiringConfirmation: 1 };
    const desktopActivity = wirePool(primary, {
      ...idle,
      activeSessions: 1,
      continuableSessions: 1,
      terminalsRequiringConfirmation: 1,
    }).toReversed();
    expect(desktopActivity[1]).not.toHaveProperty("threads");
    const confirmation = describeServerUpdate({ ...target, activity: primary, desktopActivity });
    expect(confirmation.threadActivity).toEqual([
      {
        thread: primary.threads![0],
        environmentId: primary.environmentId,
        hostLabel: null,
        continuesAfterRestart: true,
      },
    ]);
    expect(confirmation.message).toContain("2 terminal sessions will be interrupted.");
    expect(confirmation.message).toContain("1 thread will continue after the restart.");
    const requests: string[] = [];
    const decision = requestServerUpdateConfirmation(confirmation, (id) => requests.push(id));
    expect(requests).toHaveLength(1);
    respondToServerUpdateConfirmation(requests[0]!, false);
    expect(await decision).toBe(false);
  });

  it.each([idle, resumable])(
    "still presents explicit confirmation for a safe desktop pool",
    async (primary) => {
      const confirmation = describeServerUpdate({
        ...target,
        activity: primary,
        desktopActivity: wirePool(primary),
      });
      expect(confirmation.requiresConfirmation).toBe(true);
      const requests: string[] = [];
      const decision = requestServerUpdateConfirmation(confirmation, (id) => requests.push(id));
      expect(requests).toHaveLength(1);
      respondToServerUpdateConfirmation(requests[0]!, true);
      expect(await decision).toBe(true);
    },
  );

  it("keeps selected details and known sibling warnings when primary coverage fails", () => {
    const confirmation = describeServerUpdate({
      ...target,
      activity: resumable,
      desktopActivity: [
        null,
        { ...idle, isRequestingEnvironment: false, terminalsRequiringConfirmation: 1 },
      ],
    });
    expect(confirmation.requiresConfirmation).toBe(true);
    expect(confirmation.message).toContain("Could not check");
    expect(confirmation.message).toContain("1 terminal session will be interrupted.");
    expect(confirmation.threadActivity).toHaveLength(1);
  });

  it("keeps standalone server activity independent of desktop coverage", () => {
    expect(describeServerUpdate({ ...target, desktopManaged: false }).requiresConfirmation).toBe(
      false,
    );
  });
});
