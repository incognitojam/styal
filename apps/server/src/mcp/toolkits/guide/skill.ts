import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { STYAL_SKILL_NAME, styalSkillPaths } from "@t3tools/provider-core/server/styalSkill";

import { AGENT_GUIDES, type AgentGuideTopic } from "./guides.ts";

export const STYAL_SKILL_DESCRIPTION =
  "Read before setting up or explaining a styal feature: styal.json and project actions, worktree setup, t3.json migration, devices, hardware, data import, doctor, triage.";

const TOPIC_SUMMARIES: Record<AgentGuideTopic, string> = {
  "project-setup":
    "styal.json, actions, worktree setup and settle actions, t3.json migration. `t3.json` scripts do not run, so read this before adding or changing project actions.",
  orchestration:
    "delegated tasks versus independent threads, PR watches, reporting back and stopping reports.",
  devices: "simulators, emulators and physical devices, device tools, agent-device.",
  hardware: "hardware leases and hardware definitions.",
  "data-import": "importing T3 Code projects, Claude Code and Codex history, and browser sessions.",
  troubleshooting: "doctor, triage, traces, reporting a styal issue.",
};

const renderSkill = (referencePath: (topic: AgentGuideTopic) => string) =>
  [
    "---",
    `name: ${STYAL_SKILL_NAME}`,
    `description: ${JSON.stringify(STYAL_SKILL_DESCRIPTION)}`,
    "---",
    "",
    "Read the guide for the topic before you act or answer. Where a guide refers to another guide by name, it is the file for that topic.",
    "",
    ...Object.keys(AGENT_GUIDES).map((key) => {
      const topic = key as AgentGuideTopic;
      return `- \`${topic}\` (${referencePath(topic)}): ${TOPIC_SUMMARIES[topic]}`;
    }),
    "",
  ].join("\n");

/** The skill names absolute paths so any provider can read them. */
export const renderStyalSkillFiles = (
  path: Pick<Path.Path, "join">,
  stateDir: string,
): ReadonlyArray<readonly [file: string, contents: string]> => {
  const paths = styalSkillPaths(path, stateDir);
  const reference = (topic: AgentGuideTopic) =>
    path.join(paths.skillDirectory, "references", `${topic}.md`);
  return [
    [
      path.join(paths.pluginRoot, ".claude-plugin", "plugin.json"),
      `${JSON.stringify({ name: "styal", description: "styal setup guides" })}\n`,
    ],
    ...Object.entries(AGENT_GUIDES).map(
      ([topic, guide]) => [reference(topic as AgentGuideTopic), guide] as const,
    ),
    // Last: sessions treat this file as proof that the whole skill was written.
    [paths.skillFile, renderSkill(reference)],
  ];
};

/** Replaces the whole tree so updating styal also removes a retired topic. */
export const writeStyalSkill = Effect.fn("writeStyalSkill")(function* (stateDir: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.remove(styalSkillPaths(path, stateDir).pluginRoot, {
    recursive: true,
    force: true,
  });
  for (const [file, contents] of renderStyalSkillFiles(path, stateDir)) {
    yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
    yield* fileSystem.writeFileString(file, contents);
  }
});
