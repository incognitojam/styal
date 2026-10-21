import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { DesktopDiscordPresenceActivity, DesktopShutdownConfirmationRequestSchema } from "./ipc.ts";

describe("DesktopShutdownConfirmationRequestSchema", () => {
  const decode = Schema.decodeUnknownSync(DesktopShutdownConfirmationRequestSchema);
  it("accepts older confirmations and preserves structured activity across JSON IPC", () => {
    const older = { requestId: 1, message: "Restart styal?", confirmLabel: "Restart" };
    expect(decode(older)).toEqual(older);
    const current = {
      ...older,
      threadActivity: [
        {
          thread: {
            threadId: "preview",
            title: "Watch the preview build",
            reasons: ["monitor"],
            continuable: false,
          },
          hostLabel: "Lab server",
          continuesAfterRestart: false,
        },
      ],
    };
    expect(decode(JSON.parse(JSON.stringify(current)))).toEqual(current);
  });
});

describe("DesktopDiscordPresenceActivity", () => {
  const decode = Schema.decodeUnknownSync(DesktopDiscordPresenceActivity);
  it("accepts positive integer counts and strips thread metadata at the IPC boundary", () => {
    expect(decode({ activeThreads: 3, activeProjects: 2, title: "Synthetic thread" })).toEqual({
      activeThreads: 3,
      activeProjects: 2,
    });
    for (const count of [-1, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => decode({ activeThreads: count, activeProjects: 1 })).toThrow();
      expect(() => decode({ activeThreads: 1, activeProjects: count })).toThrow();
    }
  });
});
