import {
  type WorkLogPresentationEntry,
  workEntryMemoryFileKind,
  workEntryReadsMemoryFile,
} from "./presentation.ts";

/** One timeline entry as the rule sees it: a message, the work it groups, or anything else. */
export type SaveNoteStep =
  | { readonly message: { readonly role: string; readonly text: string } }
  | { readonly work: ReadonlyArray<WorkLogPresentationEntry> }
  | null;

const MEMORY_DIRECTORY_PATTERN = /\.claude\/projects\/[^/\s'"]+\/memory(?:\/|[\s'"]|$)/u;

function workEntryIsSaving(entry: WorkLogPresentationEntry): boolean {
  return (
    entry.itemType === "file_change" ||
    workEntryMemoryFileKind(entry) !== undefined ||
    workEntryReadsMemoryFile(entry) ||
    (entry.itemType === "command_execution" &&
      entry.command !== undefined &&
      MEMORY_DIRECTORY_PATTERN.test(entry.command))
  );
}

/**
 * Agents often answer, save a memory or a file, then end with a shorter note about it.
 * Returns the id of that answer, which stays visible beside the note when the turn folds.
 */
export function answerBeforeSaveNoteEntryId<Entry extends { readonly id: string }>(
  entries: ReadonlyArray<Entry>,
  terminalEntryId: string | undefined,
  read: (entry: Entry) => SaveNoteStep,
): string | null {
  const terminalIndex = entries.findIndex((entry) => entry.id === terminalEntryId);
  const terminal = terminalIndex < 0 ? null : read(entries[terminalIndex]!);
  if (terminal === null || !("message" in terminal)) return null;
  let saved = false;
  for (let index = terminalIndex - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    const step = read(entry);
    if (step === null) return null;
    if ("work" in step) {
      for (const work of step.work) {
        if (work.itemType === "reasoning") continue;
        if (!workEntryIsSaving(work)) return null;
        saved = true;
      }
      continue;
    }
    if (step.message.role !== "assistant") return null;
    return saved && step.message.text.trim().length > terminal.message.text.trim().length
      ? entry.id
      : null;
  }
  return null;
}
