import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { styalSkillPaths } from "@t3tools/provider-core/server/styalSkill";

import { DeviceToolkit } from "../device/tools.ts";
import { EnvironmentToolkit } from "../environment/tools.ts";
import { FeedbackToolkit } from "../feedback/tools.ts";
import { HardwareToolkit } from "../hardware/tools.ts";
import { ProjectToolkit } from "../project/tools.ts";
import { AGENT_GUIDES, type AgentGuideTopic } from "./guides.ts";
import { renderStyalSkillFiles } from "./skill.ts";
import { GuideToolkit } from "./tools.ts";

const toolNames = new Set(
  [
    DeviceToolkit,
    EnvironmentToolkit,
    FeedbackToolkit,
    HardwareToolkit,
    ProjectToolkit,
    GuideToolkit,
  ].flatMap((toolkit) => Object.keys(toolkit.tools)),
);

const backtickedToolNames = (text: string) =>
  [...text.matchAll(/`((?:t3|device|hardware|report)_[a-z_]+)`/gu)].map((match) => match[1]);

it("guides name only tools the server publishes", () => {
  for (const [topic, guide] of Object.entries(AGENT_GUIDES)) {
    for (const name of backtickedToolNames(guide)) {
      expect(toolNames, `${topic} names ${name}`).toContain(name);
    }
  }
});

it("guides point to topics that exist", () => {
  for (const [topic, guide] of Object.entries(AGENT_GUIDES)) {
    for (const [, referenced] of guide.matchAll(/`([a-z-]+)` guide/gu)) {
      expect(Object.keys(AGENT_GUIDES), `${topic} refers to ${referenced}`).toContain(referenced);
    }
  }
});

it.effect("the skill names real tools, lists every guide, and points only at files it writes", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const rendered = renderStyalSkillFiles(path, "/state");
    const files = new Map(rendered);
    expect(rendered.at(-1)?.[0]).toBe(styalSkillPaths(path, "/state").skillFile);
    const skill = files.get(styalSkillPaths(path, "/state").skillFile) ?? "";
    for (const name of backtickedToolNames(skill)) expect(toolNames).toContain(name);
    for (const topic of Object.keys(AGENT_GUIDES)) {
      const file = path.join(
        styalSkillPaths(path, "/state").skillDirectory,
        "references",
        `${topic}.md`,
      );
      expect(skill).toContain(file);
      expect(files.get(file)).toBe(AGENT_GUIDES[topic as AgentGuideTopic]);
    }
    expect(skill).toMatch(/^---\nname: styal-guides\ndescription: "[^"\n]+"\n---\n/u);
  }).pipe(Effect.provide(NodeServices.layer)),
);
