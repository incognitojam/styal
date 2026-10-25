import type { V2TurnStartParams__AdditionalContextEntry } from "effect-codex-app-server/schema";
import {
  ACTIVE_MCP_SERVER_NAME,
  type McpServerName,
} from "@t3tools/provider-core/server/mcpSession";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";

import {
  T3_CODE_BROWSER_TOOL_INSTRUCTIONS,
  T3_CODE_ORCHESTRATION_SECTIONS,
  renderProviderToolInstructions,
} from "@t3tools/provider-core/server/orchestrationInstructions";

/** Codex silently truncates additionalContext values over 1,000 tokens, counted as UTF-8 bytes / 4. */
export const CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES = 4_000;

const browserToolInstructionBlock = (mcpServerName: McpServerName): string =>
  T3_CODE_BROWSER_TOOL_INSTRUCTIONS.trim()
    .replaceAll("t3-code", mcpServerName)
    .replaceAll("T3 Code", "styal")
    .replaceAll("T3 preview", "styal preview");

const T3_CODE_DEVICE_TOOL_INSTRUCTIONS = `## T3 Code devices

For iOS Simulators and Android Emulators here, call \`device_list\`, then \`device_open\`. Drive the device with the exact \`agent-device\` launcher and flags it returns, on every command. Prefer \`agent-device snapshot -i\` refs over coordinates. Use \`device_screenshot\` to see the screen. Use \`xcrun simctl\` or \`adb\` only for builds, logs, and ports. If a platform is unavailable, say so.`;

export interface T3CodeToolAvailability {
  readonly browser: boolean;
  readonly device: boolean;
}

const normalizeAvailability = (
  availability: boolean | T3CodeToolAvailability,
): T3CodeToolAvailability =>
  typeof availability === "boolean" ? { browser: availability, device: false } : availability;

/** Instructions for unavailable tools would steer the model away from its remaining automation. */
const toolInstructions = (
  availability: boolean | T3CodeToolAvailability,
  mcpServerName: McpServerName,
): string => {
  const tools = normalizeAvailability(availability);
  return [
    tools.browser ? browserToolInstructionBlock(mcpServerName) : "",
    tools.device
      ? renderProviderToolInstructions(T3_CODE_DEVICE_TOOL_INSTRUCTIONS, mcpServerName)
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
};

export interface CodexRuntimeInfo {
  readonly model: string;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
}

/**
 * Codex resends each `additionalContext` entry only when its value changes. Keep this outside
 * collaboration mode; model-catalog mode text overrides client developer_instructions.
 */
export function buildCodexAdditionalContext(
  runtime: CodexRuntimeInfo,
  /**
   * Whether the product-native MCP server is attached to this turn. Callers derive
   * it from the session's actual MCP configuration rather than re-reading the
   * setting, so the prompt cannot claim tools the turn doesn't have.
   */
  toolsAvailable: boolean | T3CodeToolAvailability = true,
  additionalInstructions?: string,
  mcpServerName: McpServerName = ACTIVE_MCP_SERVER_NAME,
): Record<string, V2TurnStartParams__AdditionalContextEntry> {
  const tools = toolInstructions(toolsAvailable, mcpServerName);
  const projectContext: Record<string, V2TurnStartParams__AdditionalContextEntry> = {};
  // Project instructions allow 32,000 characters, but Codex truncates entries at 1,000 tokens.
  // Split at Unicode boundaries so the entire project instruction survives that per-entry cap.
  if (additionalInstructions) {
    let value = "";
    let bytes = 0;
    let part = 1;
    const addPart = () => {
      const key = part === 1 ? "additional_instructions" : `additional_instructions_${part}`;
      projectContext[key] = { kind: "application", value };
      part += 1;
      value = "";
      bytes = 0;
    };
    for (const character of additionalInstructions) {
      const size = Buffer.byteLength(character);
      if (bytes + size > 3_900) addPart();
      value += character;
      bytes += size;
    }
    if (value) addPart();
  }
  // Split values to fit per-entry caps; number keys because Codex emits them in key order.
  return {
    ...Object.fromEntries(
      T3_CODE_ORCHESTRATION_SECTIONS.map((section, index) => [
        `t3_code_orchestration_${String(index + 1).padStart(2, "0")}`,
        {
          kind: "application" as const,
          value: renderProviderToolInstructions(section, mcpServerName),
        },
      ]),
    ),
    t3_code_runtime: {
      kind: "application",
      value: buildRuntimeInstructions({ harness: "Codex", ...runtime }),
    },
    ...(tools ? { t3_code_tools: { kind: "application", value: tools } } : {}),
    ...projectContext,
  };
}
