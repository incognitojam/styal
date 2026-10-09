import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const ACTIVE_MCP_SERVER_NAME = "styal";
export const LEGACY_MCP_SERVER_NAME = "t3-code";
export type McpServerName = typeof ACTIVE_MCP_SERVER_NAME | typeof LEGACY_MCP_SERVER_NAME;

const McpResumeCursorMetadata = Schema.Struct({
  mcpServerName: Schema.optional(Schema.Literals([ACTIVE_MCP_SERVER_NAME, LEGACY_MCP_SERVER_NAME])),
});
const isMcpResumeCursorMetadata = Schema.is(McpResumeCursorMetadata);

/**
 * Provider histories created before the rename must keep the tool identity
 * they were given. New histories carry an explicit marker, so they continue
 * using `styal` after their first restart instead of looking legacy merely
 * because they now have a resume cursor.
 */
export function serverNameForResumeCursor(
  resumeCursor: unknown,
  hasProviderResume: boolean,
): McpServerName {
  if (!hasProviderResume) return ACTIVE_MCP_SERVER_NAME;
  return isMcpResumeCursorMetadata(resumeCursor)
    ? (resumeCursor.mcpServerName ?? LEGACY_MCP_SERVER_NAME)
    : LEGACY_MCP_SERVER_NAME;
}

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  readonly mcpServerName?: McpServerName;
  /**
   * Whether this credential includes the "preview" capability. Adapters read
   * it to keep developer instructions truthful: when the user withholds agent
   * browser access, the prompt must not advertise `preview_*` tools that every
   * call would reject.
   */
  readonly browserToolsAvailable: boolean;
  /** Capabilities the credential grants ("preview", "device"). */
  readonly capabilities?: ReadonlySet<string>;
  /**
   * Set when the session may drive devices. Adapters spread this into the
   * provider subprocess environment so the `agent-device` CLI is on PATH and
   * already pointed at the server's daemon; the agent never handles a token.
   */
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
}

/** Provider env with the device variables applied over `base`, or `base` untouched. */
export function withAgentDeviceEnvironment(
  base: NodeJS.ProcessEnv,
  config: Pick<McpProviderSessionConfig, "agentDeviceEnvironment"> | undefined,
): NodeJS.ProcessEnv {
  const extra = config?.agentDeviceEnvironment;
  if (!extra) return base;
  const separator = extra.PATH_SEPARATOR ?? ":";
  const basePath = base.PATH ?? base.Path;
  const { PATH: shimDir, PATH_SEPARATOR: _separator, ...rest } = extra;
  return {
    ...base,
    ...rest,
    ...(shimDir ? { PATH: basePath ? `${shimDir}${separator}${basePath}` : shimDir } : {}),
  };
}
