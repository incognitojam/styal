import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { DesktopDiscordPresenceActivity, DesktopEnvironmentBootstrapSchema } from "./ipc.ts";

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

describe("DesktopEnvironmentBootstrapSchema", () => {
  const decode = Schema.decodeUnknownSync(DesktopEnvironmentBootstrapSchema);

  it("preserves the concrete running distro separately from the backend id", () => {
    expect(
      decode({
        id: "wsl:default",
        label: "WSL (Ubuntu)",
        runningDistro: "Ubuntu",
        httpBaseUrl: "http://127.0.0.1:3774/",
        wsBaseUrl: "ws://127.0.0.1:3774/",
      }),
    ).toEqual({
      id: "wsl:default",
      label: "WSL (Ubuntu)",
      runningDistro: "Ubuntu",
      httpBaseUrl: "http://127.0.0.1:3774/",
      wsBaseUrl: "ws://127.0.0.1:3774/",
    });
  });

  it("allows non-running and non-WSL bootstraps to report no running distro", () => {
    expect(
      decode({
        id: "primary",
        label: "Windows",
        runningDistro: null,
        httpBaseUrl: null,
        wsBaseUrl: null,
      }).runningDistro,
    ).toBeNull();
  });
});
