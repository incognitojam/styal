import { describe, expect, it } from "vite-plus/test";

import { answerBeforeSaveNoteEntryId, type SaveNoteStep } from "./answerBeforeSaveNote.ts";
import type { WorkLogPresentationEntry } from "./presentation.ts";

const answer =
  "I've opened the PR and started the follow-up on a branch stacked on top of it. The PR has before and after screenshots at desktop and phone sizes.";
const note = "I also saved a note about that.";
const memoryDirectory = "/home/user/.claude/projects/-home-user-app/memory";

const work = (overrides: Partial<WorkLogPresentationEntry>): WorkLogPresentationEntry => ({
  id: "work",
  createdAt: "2026-01-01T00:00:00Z",
  label: "Tool",
  tone: "tool",
  ...overrides,
});
const command = (command: string) => work({ itemType: "command_execution", command });
const fileEdit = (path: string) => work({ itemType: "file_change", changedFiles: [path] });

const user = (text: string): SaveNoteStep => ({ message: { role: "user", text } });
const assistant = (text: string): SaveNoteStep => ({ message: { role: "assistant", text } });
const steps = (...work: Array<WorkLogPresentationEntry>): SaveNoteStep => ({ work });

/** The id of the entry kept beside the final one, which is always the last entry. */
const keptEntry = (timeline: ReadonlyArray<SaveNoteStep>) => {
  const entries = timeline.map((step, index) => ({ id: `entry-${index}`, step }));
  return answerBeforeSaveNoteEntryId(entries, entries.at(-1)?.id, (entry) => entry.step);
};

describe("answerBeforeSaveNoteEntryId", () => {
  it.each([
    {
      name: "a memory file and an index append",
      saving: steps(
        fileEdit(`${memoryDirectory}/branch-rename.md`),
        command(
          `cat >> ${memoryDirectory}/MEMORY.md <<'EOF'\n- [Branch rename](branch-rename.md)\nEOF`,
        ),
      ),
    },
    {
      name: "a command run in the memory directory",
      saving: steps(
        command(
          `cd ${memoryDirectory} && python3 - <<'EOF'\nopen('notes.md', 'a').write('rule')\nEOF`,
        ),
      ),
    },
    { name: "a saved file", saving: steps(fileEdit("/work/reply.txt")) },
    {
      name: "a saved file after reasoning",
      saving: steps(work({ itemType: "reasoning" }), fileEdit("/work/reply.txt")),
    },
  ])("keeps the answer above a shorter note after $name", ({ saving }) => {
    expect(keptEntry([user("Open the PR"), assistant(answer), saving, assistant(note)])).toBe(
      "entry-1",
    );
  });

  it.each([
    {
      name: "a short preamble before the answer",
      timeline: [
        user("Open the PR"),
        assistant("Saving that to memory, then I'll answer."),
        steps(fileEdit(`${memoryDirectory}/branch-rename.md`)),
        assistant(answer),
      ],
    },
    {
      name: "other work after the answer",
      timeline: [
        user("Open the PR"),
        assistant(answer),
        steps(fileEdit("/work/reply.txt"), command("rm -rf build")),
        assistant(note),
      ],
    },
    {
      name: "two messages with no work between them",
      timeline: [user("Open the PR"), assistant(answer), assistant(note)],
    },
    {
      name: "a saved file after the user's message",
      timeline: [user(answer), steps(fileEdit("/work/reply.txt")), assistant(note)],
    },
    {
      name: "a final entry that is not a message",
      timeline: [assistant(answer), steps(fileEdit("/work/reply.txt"))],
    },
  ])("keeps nothing for $name", ({ timeline }) => {
    expect(keptEntry(timeline)).toBeNull();
  });
});
