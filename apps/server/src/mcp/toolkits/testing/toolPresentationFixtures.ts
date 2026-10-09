import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as NodeModule from "node:module";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The Pi extension runs in a VM sandbox that needs the Node modules it imports.
import * as NodeFSP from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The Pi extension runs in a VM sandbox that needs the Node modules it imports.
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";
import { EnvironmentId, ProviderInstanceId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { acpMcpToolTurnItem } from "@t3tools/provider-acp/server/adapter";
import { claudeMcpQueryOverrides } from "../../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { projectCodexDynamicToolItem } from "../../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { cursorToolName } from "@t3tools/provider-cursor/testing";
import { openCodeToolTurnItem } from "@t3tools/provider-opencode/testing";
import { PI_T3_MCP_EXTENSION_SOURCE } from "@t3tools/provider-pi/server";
import { extractMcpToolCallIdentity } from "@t3tools/provider-acp/server/runtimeModel";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import { OrchestratorToolkit } from "../orchestrator/tools.ts";
import { PreviewToolkit } from "../preview/tools.ts";
import { PreviewControlsToolkit } from "../previewControls/tools.ts";
import { EnvironmentToolkit } from "../environment/tools.ts";
import { ProjectToolkit } from "../project/tools.ts";
import { AttachmentToolkit } from "../attachment/tools.ts";
import { ThreadToolkit } from "../thread/tools.ts";
import { WorktreeToolkit } from "../worktree/tools.ts";
import { DeviceToolkit } from "../device/tools.ts";
import { PullRequestsToolkit } from "../pullRequests/tools.ts";
import { HtmlToolkit } from "../html/tools.ts";

/** The same published catalog checked by core.test, also used for visual intake fixtures. */
export const publishedToolkits = [
  OrchestratorToolkit,
  PreviewToolkit,
  WorktreeToolkit,
  ThreadToolkit,
  AttachmentToolkit,
  ProjectToolkit,
  EnvironmentToolkit,
  PreviewControlsToolkit,
  DeviceToolkit,
  PullRequestsToolkit,
  HtmlToolkit,
];

export const publishedTools = publishedToolkits.flatMap((toolkit) => Object.values(toolkit.tools));

export interface ProviderToolFixture {
  readonly provider: string;
  readonly server: McpProviderSession.McpServerName;
  readonly tool: string;
  readonly toolName: string;
}

/** Run the shipped Pi extension against a synthetic MCP catalog, without a subprocess or network. */
async function piRegisteredToolNames(): Promise<string[]> {
  const names: string[] = [];
  // The sandbox supplies the extension's imports itself.
  const source = NodeModule.stripTypeScriptTypes(
    PI_T3_MCP_EXTENSION_SOURCE.replace(/^import .*;$/gmu, "").replace(
      "export default async function",
      "async function",
    ),
  );
  await NodeVM.runInNewContext(`${source}\nt3McpExtension(pi)`, {
    process: { env: { T3_MCP_URL: "https://example.com/mcp", T3_MCP_BEARER_TOKEN: "synthetic" } },
    AbortSignal,
    Type: { Unsafe: (schema: unknown) => schema },
    NodeFSP,
    NodePath,
    stripFrontmatter: (text: string) => text,
    pi: { on: () => undefined, registerTool: (tool: { name: string }) => names.push(tool.name) },
    fetch: async (_url: string, options: { body: string }) => {
      const request = JSON.parse(options.body) as { id?: number; method: string };
      const result =
        request.method === "tools/list"
          ? { tools: publishedTools.map(({ name }) => ({ name, inputSchema: { type: "object" } })) }
          : {};
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
    },
  });
  if (names.length !== publishedTools.length)
    throw new Error("Pi did not register the published catalog");
  return names;
}

/** Provider-owned mappings, plus historical spellings that existing/imported activity retains. */
export async function providerToolFixtures(): Promise<ProviderToolFixture[]> {
  const fixtures: ProviderToolFixture[] = [];
  const threadId = ThreadId.make("tool-wording-fixture");
  const piNames = await piRegisteredToolNames();
  for (const server of [
    McpProviderSession.ACTIVE_MCP_SERVER_NAME,
    McpProviderSession.LEGACY_MCP_SERVER_NAME,
  ] as const) {
    const mcpSession = {
      environmentId: EnvironmentId.make("tool-wording-fixture"),
      threadId,
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      providerSessionId: "synthetic",
      endpoint: "https://example.com/mcp",
      authorizationHeader: "Bearer synthetic",
      mcpServerName: server,
      browserToolsAvailable: true,
    };
    {
      const wildcard = claudeMcpQueryOverrides({
        mcpSession,
        readOnlySandbox: false,
      }).allowedTools?.find((name) => name.endsWith("*"));
      if (!wildcard) throw new Error("Claude did not allow the injected MCP server");
      for (const [index, tool] of publishedTools.entries()) {
        const add = (provider: string, toolName: string) =>
          fixtures.push({ provider, server, tool: tool.name, toolName });
        add("Claude", wildcard.replace("*", tool.name));
        add(
          "Codex",
          Effect.runSync(
            projectCodexDynamicToolItem({
              type: "mcpToolCall",
              id: tool.name,
              server,
              tool: tool.name,
              arguments: {},
              status: "completed",
            }).pipe(Effect.provide(NodeCrypto.layer)),
          ).toolName,
        );
        add(
          "Cursor",
          cursorToolName({
            type: "mcp",
            args: { providerIdentifier: server, toolName: tool.name },
          }),
        );
        const base = {
          id: TurnItemId.make(tool.name),
          threadId,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: index,
          status: "completed" as const,
          title: null,
          startedAt: null,
          completedAt: null,
          updatedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
        };
        const openCode = openCodeToolTurnItem(base, {
          name: `${server}_${tool.name}`,
          input: {},
          output: undefined,
          completedMetadata: undefined,
        });
        if (openCode.type !== "dynamic_tool" || !openCode.toolName)
          throw new Error(`OpenCode misclassified ${tool.name}`);
        add("OpenCode", openCode.toolName);
        // ACP (including Grok and Antigravity) recovers identity from tagged input or agent-specific titles.
        for (const [variant, data] of [
          ["tagged", { rawInput: { server, tool: tool.name }, meta: { is_mcp_tool_call: true } }],
          ["title", { title: `${server}_${tool.name}` }],
          ["normalized", { title: `mcp__${server.replaceAll("-", "_")}__${tool.name}` }],
          ["suffix", { title: `${tool.name} (${server} MCP Server)` }],
        ] as const) {
          const identity = extractMcpToolCallIdentity({ toolCallId: tool.name, data });
          if (!identity) throw new Error(`ACP ${variant} did not recover ${server}.${tool.name}`);
          add(`ACP ${variant}`, acpMcpToolTurnItem(base, identity, {}, undefined).toolName);
        }
        // Pi's shipped extension currently registers t3-code for both session generations.
        add("Pi", piNames[index]!);
        add("Saved Codex", `${server}.${tool.name}`);
        add("Imported V1", `${server} · ${tool.name}`);
      }
    }
  }
  return fixtures;
}
