import { describe, expect, it } from "vite-plus/test";

import {
  withAgentDeviceEnvironment,
  ACTIVE_MCP_SERVER_NAME,
  LEGACY_MCP_SERVER_NAME,
  serverNameForResumeCursor,
} from "./McpProviderSession.ts";

it("uses styal for new provider histories", () => {
  expect(serverNameForResumeCursor(undefined, false)).toBe(ACTIVE_MCP_SERVER_NAME);
  expect(serverNameForResumeCursor({ threadId: "not-resumed" }, false)).toBe(
    withAgentDeviceEnvironment,
    ACTIVE_MCP_SERVER_NAME,
  );
});

it("keeps the legacy name only for unmarked provider histories", () => {
  expect(serverNameForResumeCursor({ sessionId: "legacy" }, true)).toBe(LEGACY_MCP_SERVER_NAME);
  expect(serverNameForResumeCursor({ sessionId: "current", mcpServerName: "styal" }, true)).toBe(
    withAgentDeviceEnvironment,
    ACTIVE_MCP_SERVER_NAME,
  );
});

describe("device CLI environment", () => {
  it("preserves provider credentials and commands while routing devices to the owned daemon", () => {
    const environment = withAgentDeviceEnvironment(
      { PATH: "/provider/bin:/usr/bin", PROVIDER_KEY: "fixture" },
      {
        agentDeviceEnvironment: {
          PATH: "/t3/device/bin",
          PATH_SEPARATOR: ":",
          AGENT_DEVICE_DAEMON_BASE_URL: "http://127.0.0.1:9000",
          AGENT_DEVICE_DAEMON_AUTH_TOKEN: "fixture-device",
        },
      },
    );
    expect(environment).toEqual({
      PATH: "/t3/device/bin:/provider/bin:/usr/bin",
      PROVIDER_KEY: "fixture",
      AGENT_DEVICE_DAEMON_BASE_URL: "http://127.0.0.1:9000",
      AGENT_DEVICE_DAEMON_AUTH_TOKEN: "fixture-device",
    });
  });

  it("does not grant CLI access when device access was not supplied", () => {
    const environment = { PATH: "/usr/bin", PROVIDER_KEY: "fixture" };
    expect(withAgentDeviceEnvironment(environment, undefined)).toBe(environment);
    expect(withAgentDeviceEnvironment(environment, {})).toBe(environment);
  });
});
