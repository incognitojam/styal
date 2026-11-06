import { expect, it } from "@effect/vitest";

import { DeviceToolkit } from "../device/tools.ts";
import { EnvironmentToolkit } from "../environment/tools.ts";
import { FeedbackToolkit } from "../feedback/tools.ts";
import { HardwareToolkit } from "../hardware/tools.ts";
import { ProjectToolkit } from "../project/tools.ts";
import { AGENT_GUIDES } from "./guides.ts";
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

it("guides name only tools the server publishes", () => {
  for (const [topic, guide] of Object.entries(AGENT_GUIDES)) {
    const named = [...guide.matchAll(/`((?:t3|device|hardware|report)_[a-z_]+)`/gu)].map(
      (match) => match[1],
    );
    for (const name of named) expect(toolNames, `${topic} names ${name}`).toContain(name);
  }
});

it("guides point to topics that exist", () => {
  for (const [topic, guide] of Object.entries(AGENT_GUIDES)) {
    for (const [, referenced] of guide.matchAll(/`([a-z-]+)` guide/gu)) {
      expect(Object.keys(AGENT_GUIDES), `${topic} refers to ${referenced}`).toContain(referenced);
    }
  }
});
