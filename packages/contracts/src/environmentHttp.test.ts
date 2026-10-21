import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { HostActivity } from "./environmentHttp.ts";

const decodeHostActivity = Schema.decodeSync(HostActivity);

describe("HostActivity", () => {
  it("preserves the environment and saved project icon alongside affected thread titles", () => {
    const project = {
      id: "sample",
      title: "Sample project",
      workspaceRoot: "/workspace/sample",
      faviconPath: "brand/icon.svg",
      projectIcon: { kind: "emoji" as const, emoji: "🌿" },
    };
    const activity = decodeHostActivity({
      environmentId: "laptop",
      activeSessions: 1,
      continuableSessions: 0,
      waitingSessions: 0,
      terminalsRequiringConfirmation: 0,
      terminalsWithUnknownActivity: 0,
      threads: [
        {
          threadId: "release",
          title: "Review the release",
          project,
          reasons: ["running"],
          continuable: false,
        },
      ],
    });
    expect(activity.environmentId).toBe("laptop");
    expect(activity.threads?.[0]?.project).toEqual(project);
    expect(activity.threads?.[0]?.title).toBe("Review the release");
  });
  it("keeps counts and threads when a newer server sends an unknown reason", () => {
    const activity = decodeHostActivity({
      activeSessions: 1,
      continuableSessions: 0,
      waitingSessions: 0,
      terminalsRequiringConfirmation: 0,
      terminalsWithUnknownActivity: 0,
      threads: [
        {
          threadId: "release",
          title: "Review the release",
          reasons: ["future_reason", "subagent"],
          continuable: false,
        },
      ],
    });
    expect(activity.activeSessions).toBe(1);
    expect(activity.threads?.[0]?.reasons).toEqual(["subagent"]);
  });

  it("reads activity from servers that predate shared device use", () => {
    const activity = decodeHostActivity({
      activeSessions: 0,
      continuableSessions: 0,
      waitingSessions: 0,
      terminalsRequiringConfirmation: 0,
      terminalsWithUnknownActivity: 0,
    });
    expect(activity.environmentsUsingDevices).toBe(0);
    expect(activity.threads).toBeUndefined();
  });

  it("distinguishes a checked empty thread list from older servers without details", () => {
    const activity = decodeHostActivity({
      activeSessions: 0,
      continuableSessions: 0,
      waitingSessions: 0,
      threads: [],
      terminalsRequiringConfirmation: 0,
      terminalsWithUnknownActivity: 0,
    });
    expect(activity.threads).toEqual([]);
  });
});
