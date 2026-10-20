import type { OrchestrationV2ContextTransfer } from "@t3tools/contracts";

/**
 * Sent with a forked thread's first turn. The copied history can end mid-task,
 * and the agent would otherwise take its source's background work, and the
 * work that continued in the source, for its own interrupted work.
 */
export const FORK_NOTE =
  "Note: this thread is a fork of another thread. The earlier conversation was copied from that thread up to the response the user forked from. Work may have continued in that thread since then. Background work started before the fork, such as commands, monitors and subagents, belongs to that thread and will not report back here.";

/**
 * The fork transfer whose note the starting turn should carry, if any. The
 * note waits until a provider accepts a turn carrying it, which sets
 * `forkNoteDeliveredAt`, so a refused or failed attempt does not use it up and
 * a later attempt does not repeat it. A provider command such as /compact or
 * /goal must stay at the start of its text, so it is sent without the note.
 */
export function forkNoteTransfer<
  Transfer extends Pick<
    OrchestrationV2ContextTransfer,
    "type" | "targetThreadId" | "forkNoteDeliveredAt"
  >,
>(input: {
  readonly threadId: string;
  readonly messageText: string;
  readonly contextTransfers: ReadonlyArray<Transfer>;
}): Transfer | undefined {
  if (input.messageText.trimStart().startsWith("/")) return undefined;
  const fork = input.contextTransfers.findLast(
    (transfer) => transfer.type === "fork" && transfer.targetThreadId === input.threadId,
  );
  return fork?.forkNoteDeliveredAt === undefined ? fork : undefined;
}
