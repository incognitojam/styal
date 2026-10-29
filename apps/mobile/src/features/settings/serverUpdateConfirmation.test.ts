import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  describeServerUpdate,
  readServerUpdateConfirmation,
  requestServerUpdateConfirmation,
  respondToServerUpdateConfirmation,
} from "./serverUpdateConfirmation";

const idle = {
  activeSessions: 0,
  continuableSessions: 0,
  waitingSessions: 0,
  terminalsRequiringConfirmation: 0,
  terminalsWithUnknownActivity: 0,
  environmentsUsingDevices: 0,
  threads: [],
};

const base = {
  serverLabel: "Lab server",
  targetVersion: "9.1.0",
  desktopManaged: false,
  activity: idle,
  continueRunningThreads: false,
};

describe("describeServerUpdate", () => {
  it("names the version and says nothing about threads when the server is idle", () => {
    expect(describeServerUpdate(base)).toEqual({
      title: "Update Lab server?",
      message: "Install styal 9.1.0. The server will restart and reconnect.",
      threadActivity: [],
      requiresConfirmation: false,
    });
  });

  it("lists interrupted and continuing threads without repeating their counts", () => {
    const thread = (id: string, continuable: boolean) => ({
      threadId: ThreadId.make(id),
      title: id,
      reasons: ["running" as const],
      continuable,
    });
    const confirmation = describeServerUpdate({
      ...base,
      desktopManaged: true,
      desktopActivity: [{ ...idle, isRequestingEnvironment: true }],
      continueRunningThreads: true,
      activity: {
        ...idle,
        activeSessions: 2,
        continuableSessions: 1,
        terminalsRequiringConfirmation: 1,
        threads: [thread("release", true), thread("audit", false)],
      },
    });
    expect(confirmation.title).toBe("Update Lab server with running work?");
    expect(confirmation.message).toBe(
      [
        "Install styal 9.1.0. The desktop app will close and relaunch.",
        "1 terminal session will be interrupted.",
      ].join("\n"),
    );
    expect(confirmation.threadActivity.map((item) => item.continuesAfterRestart)).toEqual([
      true,
      false,
    ]);
  });

  it("warns when the server could not be checked", () => {
    expect(describeServerUpdate({ ...base, activity: null }).message).toBe(
      [
        "Install styal 9.1.0. The server will restart and reconnect.",
        "Could not check Lab server for running work.",
        "Running threads and terminals may be interrupted.",
      ].join("\n"),
    );
  });
});

describe("requestServerUpdateConfirmation", () => {
  it.each([
    ["idle", idle],
    ["resumable", { ...idle, activeSessions: 1, continuableSessions: 1 }],
  ] as const)("continues a safe %s update without presenting a sheet", async (_name, activity) => {
    const confirmation = describeServerUpdate({ ...base, continueRunningThreads: true, activity });
    const present = vi.fn();
    await expect(requestServerUpdateConfirmation(confirmation, present)).resolves.toBe(true);
    expect(present).not.toHaveBeenCalled();
  });

  it.each([
    ["a thread waiting for approval", { ...idle, waitingSessions: 1 }, true],
    ["unknown host activity", null, true],
    [
      "resumable work with continuation disabled",
      { ...idle, activeSessions: 1, continuableSessions: 1 },
      false,
    ],
  ] as const)("asks for %s", (_name, activity, continueRunningThreads) => {
    const confirmation = describeServerUpdate({ ...base, continueRunningThreads, activity });
    const present = vi.fn();
    void requestServerUpdateConfirmation(confirmation, present);
    expect(present).toHaveBeenCalledTimes(1);
  });

  it("resolves with the first answer and forgets the request", async () => {
    let requestId = "";
    const confirmation = describeServerUpdate({
      ...base,
      activity: { ...idle, terminalsRequiringConfirmation: 1 },
    });
    const answer = requestServerUpdateConfirmation(confirmation, (id) => {
      requestId = id;
    });
    expect(readServerUpdateConfirmation(requestId)).toBe(confirmation);
    respondToServerUpdateConfirmation(requestId, true);
    // The sheet's unmount cleanup answers again; that must not change the result.
    respondToServerUpdateConfirmation(requestId, false);
    await expect(answer).resolves.toBe(true);
    expect(readServerUpdateConfirmation(requestId)).toBeNull();
  });
});
