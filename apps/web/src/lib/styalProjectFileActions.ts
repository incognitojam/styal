import type {
  ProjectScript,
  StyalProjectFileScript,
  T3ProjectFile,
  T3ProjectFileScript,
} from "@t3tools/contracts";
import { STYAL_PROJECT_FILE_SCHEMA_URL } from "@t3tools/contracts";
import { nextProjectScriptId } from "@t3tools/shared/projectScripts";
import { applyEdits, modify } from "jsonc-parser";

const formattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" } as const;

export function styalFileScriptFromProjectScript(script: ProjectScript): StyalProjectFileScript {
  return {
    id: script.id,
    name: script.name,
    command: script.command,
    ...(script.icon === "play" ? {} : { icon: script.icon }),
    ...(script.runOnWorktreeCreate ? { setup: true } : {}),
  };
}

function projectScriptFromLegacyScript(
  script: T3ProjectFileScript,
  existingIds: ReadonlySet<string>,
): ProjectScript {
  return {
    id: nextProjectScriptId(script.name, existingIds),
    name: script.name,
    command: script.command,
    icon: script.icon ?? "play",
    runOnWorktreeCreate: script.runOnWorktreeCreate ?? false,
  };
}

function hasMatchingId(scripts: ReadonlyArray<ProjectScript>, candidate: ProjectScript): boolean {
  // IDs are also the keybinding identity. Preserve two otherwise-identical
  // actions when their IDs differ so migration cannot silently break a key.
  return scripts.some((script) => script.id === candidate.id);
}

/** t3.json actions that still need copying, with saved action IDs reserved. */
export function legacyT3ProjectScriptsForMigration(input: {
  liveScripts: ReadonlyArray<ProjectScript>;
  legacyFile: T3ProjectFile | null;
  savedScripts: ReadonlyArray<ProjectScript>;
}): ReadonlyArray<ProjectScript> {
  const combined = [...input.liveScripts];
  const additions: ProjectScript[] = [];
  const savedIds = new Set(input.savedScripts.map((script) => script.id));

  for (const legacyScript of input.legacyFile?.scripts ?? []) {
    if (
      input.savedScripts.some(
        (script) =>
          script.command === legacyScript.command &&
          script.name.toLowerCase() === legacyScript.name.toLowerCase(),
      )
    ) {
      continue;
    }
    const candidate = projectScriptFromLegacyScript(
      legacyScript,
      new Set([...combined.map((script) => script.id), ...savedIds]),
    );
    if (
      hasMatchingId(combined, candidate) ||
      combined.some(
        (script) =>
          script.command === candidate.command &&
          script.name.toLowerCase() === candidate.name.toLowerCase(),
      )
    ) {
      continue;
    }
    const normalized =
      candidate.runOnWorktreeCreate && combined.some((script) => script.runOnWorktreeCreate)
        ? { ...candidate, runOnWorktreeCreate: false }
        : candidate;
    combined.push(normalized);
    additions.push(normalized);
  }

  return additions;
}

/** Legacy actions that still need copying into the active checkout's styal.json. */
export function legacyProjectScriptsForMigration(input: {
  liveScripts: ReadonlyArray<ProjectScript>;
  legacyFile: T3ProjectFile | null;
  savedScripts: ReadonlyArray<ProjectScript>;
}): ReadonlyArray<ProjectScript> {
  const additions = [...legacyT3ProjectScriptsForMigration(input)];
  const combined = [...input.liveScripts, ...additions];
  const append = (candidate: ProjectScript) => {
    if (hasMatchingId(combined, candidate)) return;
    const normalized =
      candidate.runOnWorktreeCreate && combined.some((script) => script.runOnWorktreeCreate)
        ? { ...candidate, runOnWorktreeCreate: false }
        : candidate;
    combined.push(normalized);
    additions.push(normalized);
  };

  for (const savedScript of input.savedScripts) append(savedScript);
  return additions;
}

/**
 * Replace only the scripts property of an existing valid JSONC file. When the
 * checkout has not adopted styal.json yet, seed its supported settings from
 * t3.json and intentionally leave the legacy file untouched.
 */
export function styalProjectFileContentsWithScripts(input: {
  currentContents: string | null;
  legacyFile: T3ProjectFile | null;
  scripts: ReadonlyArray<ProjectScript>;
}): string {
  const scripts = input.scripts.map(styalFileScriptFromProjectScript);
  if (input.currentContents !== null) {
    return applyEdits(
      input.currentContents,
      modify(input.currentContents, ["scripts"], scripts, { formattingOptions }),
    );
  }

  const file = {
    $schema: STYAL_PROJECT_FILE_SCHEMA_URL,
    ...(input.legacyFile?.iconPath ? { iconPath: input.legacyFile.iconPath } : {}),
    ...(input.legacyFile?.defaultThreadEnvMode
      ? { defaultThreadEnvMode: input.legacyFile.defaultThreadEnvMode }
      : {}),
    scripts,
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}
