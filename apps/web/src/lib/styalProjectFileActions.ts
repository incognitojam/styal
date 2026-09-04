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
    icon: script.icon,
    runOnWorktreeCreate: script.runOnWorktreeCreate,
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

/** Legacy actions that still need copying into the active checkout's styal.json. */
export function legacyProjectScriptsForMigration(input: {
  liveScripts: ReadonlyArray<ProjectScript>;
  legacyFile: T3ProjectFile | null;
  savedScripts: ReadonlyArray<ProjectScript>;
}): ReadonlyArray<ProjectScript> {
  const combined = [...input.liveScripts];
  const additions: ProjectScript[] = [];
  const append = (candidate: ProjectScript, dedupeEquivalent: boolean) => {
    if (hasMatchingId(combined, candidate)) return;
    if (
      dedupeEquivalent &&
      combined.some(
        (script) =>
          script.command === candidate.command &&
          script.name.toLowerCase() === candidate.name.toLowerCase(),
      )
    ) {
      return;
    }
    const normalized =
      candidate.runOnWorktreeCreate && combined.some((script) => script.runOnWorktreeCreate)
        ? { ...candidate, runOnWorktreeCreate: false }
        : candidate;
    combined.push(normalized);
    additions.push(normalized);
  };

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
    append(
      projectScriptFromLegacyScript(
        legacyScript,
        new Set([...combined.map((script) => script.id), ...savedIds]),
      ),
      true,
    );
  }
  for (const savedScript of input.savedScripts) append(savedScript, false);
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
