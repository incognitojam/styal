import {
  SCRIPT_RUN_COMMAND_PATTERN,
  type KeybindingCommand,
  type ProjectScript,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export { nextProjectScriptId } from "@t3tools/shared/projectScripts";
const isScriptRunCommand = Schema.is(SCRIPT_RUN_COMMAND_PATTERN);

export interface ProjectScriptInput {
  readonly name: ProjectScript["name"];
  readonly command: ProjectScript["command"];
  readonly icon: ProjectScript["icon"];
  readonly runOnWorktreeCreate: ProjectScript["runOnWorktreeCreate"];
  readonly waitForSetup: boolean;
  readonly runOnSettle: boolean;
}

export function buildProjectScript(id: string, input: ProjectScriptInput): ProjectScript {
  return {
    id,
    name: input.name,
    command: input.command,
    icon: input.icon,
    runOnWorktreeCreate: input.runOnWorktreeCreate,
    ...(input.runOnWorktreeCreate && input.waitForSetup ? { async: false } : {}),
    ...(input.runOnSettle ? { runOnSettle: true } : {}),
  };
}

/**
 * A project runs at most one setup script and one settle script, so saving a
 * script that claims either role takes it from the script that held it.
 */
export function releaseClaimedRoles(
  script: ProjectScript,
  saved: ProjectScriptInput,
): ProjectScript {
  const releaseSetup = saved.runOnWorktreeCreate && script.runOnWorktreeCreate;
  const releaseSettle = saved.runOnSettle && script.runOnSettle === true;
  if (!releaseSetup && !releaseSettle) return script;
  return {
    ...script,
    ...(releaseSetup ? { runOnWorktreeCreate: false } : {}),
    ...(releaseSettle ? { runOnSettle: false } : {}),
  };
}

/** Legacy script IDs may not support shortcuts; keep those scripts usable without one. */
export function commandForProjectScript(scriptId: string): KeybindingCommand | null {
  const command = `script.${scriptId}.run`;
  return isScriptRunCommand(command) ? command : null;
}

export function projectScriptIdFromCommand(command: string): string | null {
  const trimmed = command.trim();
  if (!isScriptRunCommand(trimmed)) {
    return null;
  }
  const [prefix, , suffix] = SCRIPT_RUN_COMMAND_PATTERN.parts;
  return trimmed.slice(prefix.literal.length, -suffix.literal.length);
}

export function primaryProjectScript(scripts: ReadonlyArray<ProjectScript>): ProjectScript | null {
  const regular = scripts.find((script) => !script.runOnWorktreeCreate && !script.runOnSettle);
  return regular ?? scripts.find((script) => !script.runOnSettle) ?? null;
}
