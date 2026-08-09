import type { CommandInteractionKind } from "@t3tools/contracts";

export function classifyCommandInteraction(stdin: string): CommandInteractionKind | null {
  if (stdin.length === 0) {
    return null;
  }
  if (stdin === "\u0003") {
    return "ctrl_c";
  }
  if (stdin === "\u0004") {
    return "ctrl_d";
  }
  if ([...stdin].every((character) => character.charCodeAt(0) <= 0x1f || character === "\u007f")) {
    return "control";
  }
  return "input";
}

export function commandInteractionSummary(interaction: CommandInteractionKind): string {
  switch (interaction) {
    case "ctrl_c":
      return "Sent Ctrl+C";
    case "ctrl_d":
      return "Sent Ctrl+D";
    case "control":
      return "Sent control input";
    case "input":
      return "Sent input to command";
  }
}
