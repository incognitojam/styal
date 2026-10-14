import { expect, it } from "@effect/vitest";
import { resolveT3McpToolDefinition } from "@t3tools/shared/t3McpToolPresentation";
import { STYAL_PREVIEW_TOOL_LABELS } from "@t3tools/shared/styalToolWording";
import {
  deriveToolRowPresentation,
  STYAL_PREVIEW_TOOL_ARGUMENTS,
} from "@t3tools/shared/toolRowPresentation";
import {
  resolveWorkEntryToolPresentation,
  resolveWorkEntryToolRowPresentation,
  summarizeToolGroup,
  toolGroupAction,
} from "../../../../../packages/client-runtime/src/work-log/presentation.ts";
import { providerToolFixtures, publishedTools } from "./testing/toolPresentationFixtures.ts";

it("presents every published tool consistently after each provider's identity mapping", async () => {
  const fixtures = await providerToolFixtures();
  for (const { provider, server, tool, toolName } of fixtures) {
    const context = `${provider} / ${server} / ${tool}`;
    const canonical = resolveT3McpToolDefinition(tool);
    expect(resolveT3McpToolDefinition(toolName), context).toEqual(canonical);
    for (const status of ["inProgress", "completed", "failed", "declined", "stopped"] as const) {
      const entry = {
        id: tool,
        label: "Provider-specific title",
        toolName,
        toolLifecycleStatus: status,
        createdAt: "2026-01-01T00:00:00Z",
        tone: "tool" as const,
      };
      const presentation = resolveWorkEntryToolPresentation(entry);
      expect(presentation, context).not.toBeNull();
      expect(presentation?.icon, context).toBe(canonical?.icon);
      expect(resolveWorkEntryToolRowPresentation(entry)?.heading, context).toBe(
        presentation?.displayName,
      );
      expect(presentation?.displayName, context).not.toMatch(/\bT3\b|mcp__|[._]preview_/u);
      expect(presentation?.displayName.trim(), context).toBe(presentation?.displayName);
      if (status === "completed" || status === "failed" || status === "stopped") {
        expect(
          deriveToolRowPresentation({
            toolName,
            failed: status === "failed",
            stopped: status === "stopped",
          })?.heading,
          context,
        ).toBe(presentation?.displayName);
      }
      if (canonical?.icon === "browser" || canonical?.icon === "device") {
        expect(toolGroupAction(entry), context).toBe(canonical.icon);
      }
      if (status === "completed") {
        const summary = summarizeToolGroup([entry]);
        expect(summary.summary, context).not.toMatch(/\bT3\b|mcp__/u);
      }
    }
  }
});

it("requires review of new preview tools and rejects retired fork customizations", () => {
  const names = new Set(publishedTools.map(({ name }) => name));
  for (const name of names) {
    if (name.startsWith("preview_"))
      expect(Object.hasOwn(STYAL_PREVIEW_TOOL_LABELS, name), name).toBe(true);
  }
  for (const name of [
    ...Object.keys(STYAL_PREVIEW_TOOL_LABELS),
    ...Object.keys(STYAL_PREVIEW_TOOL_ARGUMENTS),
  ]) {
    expect(names.has(name), `${name} customization is no longer published`).toBe(true);
  }
});
