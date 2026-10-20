import type {
  OrchestrationV2ContextTransfer,
  OrchestrationV2ProviderTurn,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
} from "@t3tools/contracts";

/**
 * Sent with a forked thread's first turn. The copied history can end mid-task,
 * and the agent would otherwise take its source's background work, and the
 * work that continued in the source, for its own interrupted work.
 */
export const FORK_NOTE =
  "Note: this thread is a fork of another thread. The earlier conversation was copied from that thread up to the response the user forked from. Work may have continued in that thread since then. Background work started before the fork, such as commands, monitors and subagents, belongs to that thread and will not report back here.";

/**
 * Whether the starting attempt carries `FORK_NOTE`. The note goes with the
 * first turn of a forked thread that the provider accepts, so an attempt that
 * failed before its prompt does not use it up and a steer that replaces an
 * accepted attempt does not repeat it. A provider command such as /compact or
 * /goal must stay at the start of its text, so it neither carries the note
 * nor counts as having delivered it.
 */
export function shouldSendForkNote(input: {
  readonly threadId: string;
  readonly run: Pick<OrchestrationV2Run, "userMessageId">;
  readonly attemptId: string;
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "userMessageId">>;
  readonly attempts: ReadonlyArray<Pick<OrchestrationV2RunAttempt, "id" | "runId">>;
  readonly providerTurns: ReadonlyArray<Pick<OrchestrationV2ProviderTurn, "runAttemptId">>;
  readonly messages: ReadonlyArray<{ readonly id: string; readonly text: string }>;
  readonly contextTransfers: ReadonlyArray<
    Pick<OrchestrationV2ContextTransfer, "type" | "targetThreadId">
  >;
}): boolean {
  const isProviderCommand = (messageId: string | undefined) =>
    input.messages
      .find((message) => message.id === messageId)
      ?.text.trimStart()
      .startsWith("/") ?? false;
  if (isProviderCommand(input.run.userMessageId)) return false;
  if (
    !input.contextTransfers.some(
      (transfer) => transfer.type === "fork" && transfer.targetThreadId === input.threadId,
    )
  ) {
    return false;
  }
  const acceptedAttemptIds = new Set(input.providerTurns.map((turn) => turn.runAttemptId));
  return !input.attempts.some(
    (attempt) =>
      attempt.id !== input.attemptId &&
      acceptedAttemptIds.has(attempt.id) &&
      !isProviderCommand(input.runs.find((run) => run.id === attempt.runId)?.userMessageId),
  );
}
