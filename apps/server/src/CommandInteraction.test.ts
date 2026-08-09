import { describe, expect, it } from "vite-plus/test";

import { classifyCommandInteraction, commandInteractionSummary } from "./CommandInteraction.ts";

describe("command interactions", () => {
  it.each([
    ["", null],
    ["\u0003", "ctrl_c"],
    ["\u0004", "ctrl_d"],
    ["\n", "control"],
    ["\u0001\u0002", "control"],
    ["y\n", "input"],
    ["secret", "input"],
  ] as const)("classifies %j as %s", (stdin, expected) => {
    expect(classifyCommandInteraction(stdin)).toBe(expected);
  });

  it.each([
    ["ctrl_c", "Sent Ctrl+C"],
    ["ctrl_d", "Sent Ctrl+D"],
    ["control", "Sent control input"],
    ["input", "Sent input to command"],
  ] as const)("labels %s without including input", (interaction, expected) => {
    expect(commandInteractionSummary(interaction)).toBe(expected);
  });
});
