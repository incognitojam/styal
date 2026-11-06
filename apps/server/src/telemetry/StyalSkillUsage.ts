import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { STYAL_SKILL_NAME } from "@t3tools/provider-core/server/styalSkill";

import { AgentGuideTopic } from "../mcp/toolkits/guide/guides.ts";
import * as AnalyticsService from "./AnalyticsService.ts";

const SKILL_PATH = new RegExp(
  `agent-skills[\\\\/]+styal[\\\\/]+skills[\\\\/]+${STYAL_SKILL_NAME}(?:[\\\\/]+references[\\\\/]+([a-z-]+)\\.md)?`,
  "gu",
);
const isGuideTopic = Schema.is(AgentGuideTopic);
const MAX_RECORDED_ITEMS = 1_000;

export interface StyalSkillUse {
  readonly guideTopic?: AgentGuideTopic;
}

const usesIn = (text: string): ReadonlyArray<StyalSkillUse> => {
  const matches = [...text.matchAll(SKILL_PATH)];
  if (matches.length === 0) return [];
  const topics = new Set(matches.map((match) => match[1]).filter(isGuideTopic));
  return topics.size === 0 ? [{}] : [...topics].map((guideTopic) => ({ guideTopic }));
};

/** Providers open a skill with a Skill tool, a file read or a shell command. */
export const styalSkillUses = (item: OrchestrationV2TurnItem): ReadonlyArray<StyalSkillUse> => {
  if (item.status !== "completed") return [];
  if (item.type === "command_execution") return usesIn(item.input);
  if (item.type !== "dynamic_tool") return [];
  const input = JSON.stringify(item.input ?? null);
  if (item.toolName?.toLowerCase() === "skill") return input.includes(STYAL_SKILL_NAME) ? [{}] : [];
  return usesIn(input);
};

export class StyalSkillAnalytics extends Context.Reference<{
  readonly record: (item: OrchestrationV2TurnItem) => Effect.Effect<void>;
}>("t3/telemetry/StyalSkillAnalytics", {
  defaultValue: () => ({ record: () => Effect.void }),
}) {}

export const layer = Layer.effect(
  StyalSkillAnalytics,
  Effect.gen(function* () {
    const analytics = yield* AnalyticsService.AnalyticsService;
    // A provider can send a completed item again, as OpenCode does after a reconnect.
    const recorded = new Set<string>();
    return {
      record: Effect.fnUntraced(function* (item: OrchestrationV2TurnItem) {
        const uses = styalSkillUses(item);
        if (uses.length === 0 || recorded.has(item.id)) return;
        if (recorded.size >= MAX_RECORDED_ITEMS) recorded.clear();
        recorded.add(item.id);
        for (const use of uses) {
          yield* analytics.record("feature.used", {
            feature: "agent-guides",
            source: "agent",
            action: use.guideTopic === undefined ? "open" : "read",
            guideRoute: "skill",
            ...use,
            outcome: "success",
          });
        }
      }),
    };
  }),
);
