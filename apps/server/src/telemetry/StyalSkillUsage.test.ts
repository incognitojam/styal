import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { OrchestrationV2TurnItem } from "@t3tools/contracts";

import * as AnalyticsService from "./AnalyticsService.ts";
import { layer, StyalSkillAnalytics, styalSkillUses } from "./StyalSkillUsage.ts";

const root = "/state/agent-skills/styal/skills/styal-guides";
const tool = (toolName: string, input: unknown, status = "completed") =>
  ({
    id: "item",
    type: "dynamic_tool",
    toolName,
    input,
    status,
  }) as unknown as OrchestrationV2TurnItem;
const command = (input: string) =>
  ({
    id: "item",
    type: "command_execution",
    input,
    status: "completed",
  }) as unknown as OrchestrationV2TurnItem;

describe("styalSkillUses", () => {
  it.each([
    ["Claude Skill", tool("Skill", { skill: "styal:styal-guides" }), [{}]],
    ["OpenCode skill", tool("skill", { id: "styal-guides" }), [{}]],
    ["Codex opening SKILL.md", command(`sed -n 1,50p ${root}/SKILL.md`), [{}]],
    [
      "a read of a guide",
      tool("Read", { file_path: `${root}/references/hardware.md` }),
      [{ guideTopic: "hardware" }],
    ],
    [
      "a Windows path",
      tool("Read", {
        file_path:
          "C:\\\\state\\\\agent-skills\\\\styal\\\\skills\\\\styal-guides\\\\references\\\\devices.md",
      }),
      [{ guideTopic: "devices" }],
    ],
    [
      "one command reading the skill and two guides",
      command(`cat ${root}/SKILL.md ${root}/references/devices.md ${root}/references/hardware.md`),
      [{ guideTopic: "devices" }, { guideTopic: "hardware" }],
    ],
    ["an unknown file", command(`cat ${root}/references/other.md`), [{}]],
    ["another skill", tool("Skill", { skill: "frontend-design" }), []],
    ["ordinary work", command("pnpm test"), []],
    ["a read still running", tool("Read", { file_path: `${root}/SKILL.md` }, "running"), []],
  ])("%s", (_name, item, expected) => {
    expect(styalSkillUses(item)).toEqual(expected);
  });
});

it.effect("records a completed item once when the provider sends it again", () =>
  Effect.gen(function* () {
    const events: Array<unknown> = [];
    const analytics = yield* StyalSkillAnalytics.pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(
            Layer.mock(AnalyticsService.AnalyticsService)({
              record: (_event, properties) => Effect.sync(() => void events.push(properties)),
            }),
          ),
        ),
      ),
    );
    const item = tool("read", { path: `${root}/references/hardware.md` });
    yield* analytics.record(item);
    yield* analytics.record(item);
    expect(events).toEqual([
      {
        feature: "agent-guides",
        source: "agent",
        action: "read",
        guideRoute: "skill",
        guideTopic: "hardware",
        outcome: "success",
      },
    ]);
  }),
);
