import { expect, it } from "vite-plus/test";

import {
  ACTIVE_MCP_SERVER_NAME,
  LEGACY_MCP_SERVER_NAME,
  serverNameForResumeCursor,
} from "./McpProviderSession.ts";

it("uses styal for new provider histories", () => {
  expect(serverNameForResumeCursor(undefined, false)).toBe(ACTIVE_MCP_SERVER_NAME);
  expect(serverNameForResumeCursor({ threadId: "not-resumed" }, false)).toBe(
    ACTIVE_MCP_SERVER_NAME,
  );
});

it("keeps the legacy name only for unmarked provider histories", () => {
  expect(serverNameForResumeCursor({ sessionId: "legacy" }, true)).toBe(LEGACY_MCP_SERVER_NAME);
  expect(serverNameForResumeCursor({ sessionId: "current", mcpServerName: "styal" }, true)).toBe(
    ACTIVE_MCP_SERVER_NAME,
  );
});
